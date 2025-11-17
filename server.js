/* jshint node: true, esversion: 11 */
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { URL: NodeURL } = require("url");

const app = express();
const PORT = process.env.PORT || 8080;

// ===== Config =====
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";
const API_KEYS = (process.env.API_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const dbUrl = new NodeURL(process.env.DATABASE_URL || "");
const useInternal = dbUrl.hostname.endsWith("railway.internal");
const sslSetting = useInternal ? false : { rejectUnauthorized: false };

console.log(`[db] using: ${dbUrl.hostname}:${dbUrl.port || 5432} ssl: ${sslSetting ? "true(no-verify)" : "false"}`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslSetting,
});

// ===== Helpers =====
function hmacHex(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}

function verifyHmacHeader(req, body) {
  const header = req.get("X-Signature") || req.get("x-signature") || "";
  if (!header.startsWith("sha256=")) return false;
  const gotHex = header.slice("sha256=".length);
  const exact = hmacHex(body);
  const alt = body.endsWith("\n") ? hmacHex(body.slice(0, -1)) : hmacHex(body + "\n");
  try {
    const got = Buffer.from(gotHex, "hex");
    const exp = Buffer.from(exact, "hex");
    const altB = Buffer.from(alt, "hex");
    return (
      (got.length === exp.length && crypto.timingSafeEqual(got, exp)) ||
      (got.length === altB.length && crypto.timingSafeEqual(got, altB))
    );
  } catch {
    return false;
  }
}

function ndjsonFromRows(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function setNdjsonHeaders(res, noCache, body) {
  const etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    noCache
      ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60"
  );
  return etag;
}

const ndjsonBody = express.text({ type: "*/*", limit: "5mb" });
app.disable("x-powered-by");

// ===== Satellite Ingestion API (CLI) - Must be before express.json() =====
// POST /v1/streams/ingest
// Accepts Bearer token auth, gzipped NDJSON from CLI
app.post("/v1/streams/ingest", express.raw({ type: "application/x-ndjson", limit: "5mb" }), async (req, res) => {
  console.log("[ingest] POST /v1/streams/ingest received");
  try {
    // Verify Bearer token (simple check - you can enhance this)
    const authHeader = req.get("Authorization") || "";
    const apiKey = authHeader.replace("Bearer ", "").trim();
    if (!apiKey) {
      return res.status(401).json({ ok: false, error: "Missing API key" });
    }
    // If API_KEYS env var is set, validate against it; otherwise allow any non-empty key
    if (API_KEYS.length > 0 && !API_KEYS.includes(apiKey)) {
      return res.status(401).json({ ok: false, error: "Invalid API key" });
    }

    // Get headers
    const datasetId = req.get("X-Dataset-Id") || "default";
    const site = req.get("X-Site") || "";
    const contentHash = req.get("X-Content-Hash") || "";
    const schemaVersion = req.get("X-Schema-Version") || "1";

    // Handle gzip decompression
    let body = req.body;
    const contentEncoding = req.get("Content-Encoding") || "";
    
    console.log("[ingest] Content-Encoding:", contentEncoding, "Body type:", typeof body, "IsBuffer:", Buffer.isBuffer(body));
    
    if (contentEncoding === "gzip" && Buffer.isBuffer(body)) {
      try {
        const zlib = require("zlib");
        body = zlib.gunzipSync(body);
      } catch (e) {
        console.error("[ingest] Gzip decompression error:", e.message);
        // Try parsing as plain text if gzip fails
        console.log("[ingest] Attempting to parse as plain text");
        body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      }
    }
    
    // Convert to string
    const ndjson = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
    
    console.log("[ingest] Parsed NDJSON length:", ndjson.length, "First 100 chars:", ndjson.substring(0, 100));

    // Parse NDJSON lines
    const lines = ndjson.split("\n").filter((line) => line.trim());
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch (e) {
        console.warn("[ingest] Skipping invalid JSON line:", line.substring(0, 100));
      }
    }

    if (records.length === 0) {
      return res.status(400).json({ ok: false, error: "No valid records found" });
    }

    // Process records and insert into DB
    let inserted = 0;
    let triplesCreated = 0;

    for (const record of records) {
      const recordType = record["@type"] || "";
      
      // For now, only handle Factlet records (matching CLI format)
      if (recordType === "Factlet") {
        const factId = record.fact_id || record["@id"] || "";
        const pageId = record.page_id || site || "unknown";
        const claim = record.claim || record.text || "";
        const passageId = record.passage_id || "";

        if (!factId || !claim || !pageId) {
          console.warn(`[ingest] Skipping record: factId=${!!factId}, claim=${!!claim}, pageId=${!!pageId}`);
          continue; // Skip invalid records
        }

        // Create crouton_id from fact_id
        const croutonId = factId;

        // Extract triple if available, otherwise create a simple one
        let triple = null;
        if (record.about || record.normalized?.about) {
          const about = record.about || record.normalized?.about;
          const aboutId = about["@id"] || about.id || String(about);
          const aboutName = about.name || aboutId;
          triple = {
            subject: factId,
            predicate: "about",
            object: aboutId
          };
        } else if (record.provider) {
          const provider = record.provider;
          const providerId = provider["@id"] || provider.id || String(provider);
          triple = {
            subject: factId,
            predicate: "providedBy",
            object: providerId
          };
        }

        // Insert crouton
        // Use crouton_id as source_hash since it's already unique
        // This ensures each record has a unique source_hash and prevents duplicate key violations
        const recordHash = croutonId; // crouton_id is already unique, so use it as source_hash
        
        try {
          const result = await pool.query(
            `INSERT INTO croutons (crouton_id, source_url, text, corpus_id, triple, source_hash)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (crouton_id) DO UPDATE SET
               source_url = EXCLUDED.source_url,
               text = EXCLUDED.text,
               triple = EXCLUDED.triple,
               source_hash = EXCLUDED.source_hash`,
            [croutonId, pageId, claim, datasetId, triple ? JSON.stringify(triple) : null, recordHash]
          );
          inserted++;
          if (inserted % 100 === 0) {
            console.log(`[ingest] Inserted ${inserted} croutons so far...`);
          }

          // Insert triple if available
          if (triple) {
            try {
              await pool.query(
                `INSERT INTO triples (subject, predicate, object, evidence_crouton_id)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (subject, predicate, object) DO NOTHING`,
                [triple.subject, triple.predicate, triple.object, croutonId]
              );
              triplesCreated++;
            } catch (e) {
              console.warn("[ingest] Triple insert error:", e.message);
            }
          }
        } catch (e) {
          console.error(`[ingest] Crouton insert error for ${croutonId}:`, e.message);
          console.error(`[ingest]   pageId: ${pageId}, claim length: ${claim.length}, datasetId: ${datasetId}`);
          if (e.code) {
            console.error(`[ingest]   Error code: ${e.code}`);
          }
        }
      }
    }

    res.json({
      ok: true,
      dataset_id: datasetId,
      site: site,
      schema_version: schemaVersion,
      records_received: records.length,
      records_inserted: inserted,
      triples_created: triplesCreated,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error("[ingest] Error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use(express.json({ limit: "5mb" }));

// ===== Core API Endpoints =====
// POST /api/import - Accept NDJSON factlets & triples with HMAC signature
app.post("/api/import", ndjsonBody, async (req, res) => {
  try {
    const body = req.body;
    
    // Verify HMAC signature
    if (!verifyHmacHeader(req, body)) {
      return res.status(401).json({ ok: false, error: "Invalid HMAC signature" });
    }

    // Parse NDJSON lines
    const lines = body.split("\n").filter((line) => line.trim());
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch (e) {
        console.warn("[import] Skipping invalid JSON line:", line.substring(0, 100));
      }
    }

    if (records.length === 0) {
      return res.status(400).json({ ok: false, error: "No valid records found" });
    }

    let factletsInserted = 0;
    let triplesInserted = 0;
    const pagesUpserted = new Set();

    for (const record of records) {
      const recordType = record["@type"] || "";

      if (recordType === "Factlet") {
        const factId = record.fact_id || record["@id"] || "";
        const pageId = record.page_id || "";
        const claim = record.claim || record.text || "";
        const passageId = record.passage_id || "";

        if (!factId || !claim || !pageId) {
          continue;
        }

        // Upsert page (track unique pages)
        pagesUpserted.add(pageId);

        // Insert factlet (crouton)
        try {
          await pool.query(
            `INSERT INTO croutons (crouton_id, source_url, text, corpus_id, triple, source_hash)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (crouton_id) DO UPDATE SET
               source_url = EXCLUDED.source_url,
               text = EXCLUDED.text,
               triple = EXCLUDED.triple,
               source_hash = EXCLUDED.source_hash`,
            [factId, pageId, claim, record.corpus_id || "default", null, null]
          );
          factletsInserted++;
        } catch (e) {
          console.error("[import] Factlet insert error:", e.message);
        }
      } else if (recordType === "Triple") {
        const subject = record.subject || "";
        const predicate = record.predicate || "";
        const object = record.object || "";
        const evidenceFactId = record.evidence_fact_id || record.evidence_crouton_id || null;

        if (!subject || !predicate || !object) {
          continue;
        }

        // Insert triple
        try {
          await pool.query(
            `INSERT INTO triples (subject, predicate, object, evidence_crouton_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (subject, predicate, object) DO NOTHING`,
            [subject, predicate, object, evidenceFactId]
          );
          triplesInserted++;
        } catch (e) {
          console.error("[import] Triple insert error:", e.message);
        }
      }
    }

    res.json({
      ok: true,
      records_received: records.length,
      factlets_inserted: factletsInserted,
      triples_inserted: triplesInserted,
      pages_upserted: pagesUpserted.size,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error("[import] Error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/pages - Return paginated list of crawled pages
app.get("/api/pages", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50", 10)));
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      `SELECT 
         source_url AS url,
         COUNT(*)::int AS factlet_count,
         MIN(created_at) AS first_seen_at,
         MAX(created_at) AS last_seen_at
       FROM croutons
       GROUP BY source_url
       ORDER BY last_seen_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT source_url)::int AS total FROM croutons`
    );
    const total = countResult.rows[0].total;

    res.json({
      ok: true,
      pages: rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/facts - Return claims + metadata
app.get("/api/facts", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50", 10)));
    const offset = (page - 1) * limit;
    const sourceUrl = req.query.source_url || null;

    let query = `SELECT 
      crouton_id AS fact_id,
      source_url AS page_id,
      text AS claim,
      triple,
      confidence,
      verified_at,
      created_at
    FROM croutons WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (sourceUrl) {
      query += ` AND source_url = $${paramIdx}`;
      params.push(sourceUrl);
      paramIdx++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(limit, offset);

    const { rows } = await pool.query(query, params);

    const countQuery = sourceUrl 
      ? `SELECT COUNT(*)::int AS total FROM croutons WHERE source_url = $1`
      : `SELECT COUNT(*)::int AS total FROM croutons`;
    const countParams = sourceUrl ? [sourceUrl] : [];
    const countResult = await pool.query(countQuery, countParams);
    const total = countResult.rows[0].total;

    res.json({
      ok: true,
      facts: rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/triples - Return subject-predicate-object triples
app.get("/api/triples", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50", 10)));
    const offset = (page - 1) * limit;
    const subject = req.query.subject || null;
    const predicate = req.query.predicate || null;
    const object = req.query.object || null;

    let query = `SELECT 
      subject,
      predicate,
      object,
      evidence_crouton_id,
      created_at
    FROM triples WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (subject) {
      query += ` AND subject = $${paramIdx}`;
      params.push(subject);
      paramIdx++;
    }
    if (predicate) {
      query += ` AND predicate = $${paramIdx}`;
      params.push(predicate);
      paramIdx++;
    }
    if (object) {
      query += ` AND object = $${paramIdx}`;
      params.push(object);
      paramIdx++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(limit, offset);

    const { rows } = await pool.query(query, params);

    let countQuery = `SELECT COUNT(*)::int AS total FROM triples WHERE 1=1`;
    const countParams = [];
    let countParamIdx = 1;
    if (subject) {
      countQuery += ` AND subject = $${countParamIdx}`;
      countParams.push(subject);
      countParamIdx++;
    }
    if (predicate) {
      countQuery += ` AND predicate = $${countParamIdx}`;
      countParams.push(predicate);
      countParamIdx++;
    }
    if (object) {
      countQuery += ` AND object = $${countParamIdx}`;
      countParams.push(object);
      countParamIdx++;
    }
    const countResult = await pool.query(countQuery, countParams);
    const total = countResult.rows[0].total;

    res.json({
      ok: true,
      triples: rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/graph - Return {nodes, links} for D3 visualization (capped at 500 nodes, 1000 links)
app.get("/api/graph", async (req, res) => {
  try {
    const maxNodes = 500;
    const maxLinks = 1000;

    // Get all triples
    const { rows: triples } = await pool.query(
      `SELECT subject, predicate, object, evidence_crouton_id, created_at
       FROM triples
       ORDER BY created_at DESC
       LIMIT $1`,
      [maxLinks * 2] // Get more to ensure we have enough for filtering
    );

    // Build nodes and links
    const nodesMap = Object.create(null);
    const links = [];

    for (const t of triples) {
      const s = String(t.subject || "").trim();
      const o = String(t.object || "").trim();
      const p = String(t.predicate || "").trim();
      if (!s || !o) continue;

      // Only add if we haven't exceeded node limit
      if (Object.keys(nodesMap).length < maxNodes) {
        if (!nodesMap[s]) {
          nodesMap[s] = { id: s, degree: 0 };
        }
        if (!nodesMap[o]) {
          nodesMap[o] = { id: o, degree: 0 };
        }
      }

      // Only add link if both nodes exist
      if (nodesMap[s] && nodesMap[o] && links.length < maxLinks) {
        nodesMap[s].degree++;
        nodesMap[o].degree++;
        links.push({
          source: s,
          target: o,
          label: p,
          evidence_crouton_id: t.evidence_crouton_id || null
        });
      }
    }

    const nodes = Object.values(nodesMap);

    res.json({
      ok: true,
      nodes,
      links,
      meta: {
        node_count: nodes.length,
        link_count: links.length,
        capped: nodes.length >= maxNodes || links.length >= maxLinks
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Health =====
app.get("/healthz", (_req, res) => res.send("ok"));

// Test route for debugging
app.get("/api/test", (_req, res) => res.json({ ok: true, message: "API routes working" }));
app.post("/api/test", (_req, res) => res.json({ ok: true, message: "POST routes working" }));
app.post("/v1/test", (_req, res) => res.json({ ok: true, message: "POST v1 routes working" }));

// ===== DB Diagnostics =====
app.get("/diag/db", async (_req, res) => {
  try {
    const r = await pool.query("SELECT now(), current_database()");
    res.json({ ok: true, result: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Stats =====
app.get("/diag/stats", async (_req, res) => {
  try {
    // Use v_counts view if available, fallback to direct queries
    try {
      const { rows } = await pool.query("SELECT * FROM v_counts");
      const counts = rows[0];
      res.json({
        ok: true,
        counts: {
          croutons: counts.croutons_count || 0,
          triples: counts.triples_count || 0,
          pages: counts.pages_count || 0,
          unique_subjects: counts.unique_subjects_count || 0,
          unique_objects: counts.unique_objects_count || 0,
          unique_predicates: counts.unique_predicates_count || 0
        },
        last_crouton_at: counts.last_crouton_at,
        last_triple_at: counts.last_triple_at,
        time: new Date().toISOString(),
      });
    } catch (viewError) {
      // Fallback if view doesn't exist yet
      const cr = await pool.query("SELECT COUNT(*)::int AS n FROM croutons");
      const tr = await pool.query("SELECT COUNT(*)::int AS n FROM triples");
      res.json({
        ok: true,
        counts: { croutons: cr.rows[0].n, triples: tr.rows[0].n },
        time: new Date().toISOString(),
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== Feeds =====
app.get("/feeds/croutons.ndjson", async (req, res) => {
  const noCache = String(req.query.nocache || "") === "1";
  const { rows } = await pool.query(
    `SELECT id::text, crouton_id, source_url, source_hash, corpus_id, triple, text,
            confidence, verified_at, created_at, context_hash, contextually_verified, verification_meta
     FROM croutons ORDER BY created_at ASC`
  );
  const body = ndjsonFromRows(rows);
  const etag = setNdjsonHeaders(res, noCache, body);
  if (req.headers["if-none-match"] === etag && !noCache) return res.status(304).end();
  res.send(body);
});

app.get("/feeds/graph.json", async (req, res) => {
  const noCache = String(req.query.nocache || "") === "1";
  const { rows } = await pool.query(
    `SELECT subject, predicate, object, evidence_crouton_id, created_at FROM triples ORDER BY created_at ASC`
  );
  const payload = { generated_at: new Date().toISOString(), triples: rows };
  const body = JSON.stringify(payload, null, 2);
  const etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    noCache
      ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60"
  );
  if (req.headers["if-none-match"] === etag && !noCache) return res.status(304).end();
  res.send(body);
});

app.get("/feeds/corpus.json", async (req, res) => {
  const noCache = String(req.query.nocache || "") === "1";
  
  // Get pages with factlet counts
  const { rows: pages } = await pool.query(
    `SELECT 
       source_url AS url,
       COUNT(*)::int AS factlet_count,
       MIN(created_at) AS first_seen_at,
       MAX(created_at) AS last_seen_at
     FROM croutons
     GROUP BY source_url
     ORDER BY last_seen_at DESC`
  );

  // Get factlets
  const { rows: factlets } = await pool.query(
    `SELECT 
       crouton_id AS fact_id,
       source_url AS page_id,
       text AS claim,
       triple,
       confidence,
       verified_at,
       created_at
     FROM croutons
     ORDER BY created_at ASC`
  );

  const payload = {
    generated_at: new Date().toISOString(),
    pages: pages,
    factlets: factlets
  };
  
  const body = JSON.stringify(payload, null, 2);
  const etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    noCache
      ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60"
  );
  if (req.headers["if-none-match"] === etag && !noCache) return res.status(304).end();
  res.send(body);
});

// ===== Admin Search =====
app.get("/admin/search/croutons", async (req, res) => {
  try {
    const text = String(req.query.text || "").trim();
    const sourceUrl = String(req.query.source_url || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const newest = String(req.query.newest || "1") === "1";

    let query = "SELECT * FROM croutons WHERE 1=1";
    const params = [];
    let paramIdx = 1;

    if (text) {
      query += ` AND text ILIKE $${paramIdx}`;
      params.push(`%${text}%`);
      paramIdx++;
    }
    if (sourceUrl) {
      query += ` AND source_url ILIKE $${paramIdx}`;
      params.push(`%${sourceUrl}%`);
      paramIdx++;
    }

    query += ` ORDER BY created_at ${newest ? "DESC" : "ASC"} LIMIT $${paramIdx}`;
    params.push(limit);

    const { rows } = await pool.query(query, params);
    res.json({ count: rows.length, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/admin/search/triples", async (req, res) => {
  try {
    const subject = String(req.query.subject || "").trim();
    const predicate = String(req.query.predicate || "").trim();
    const object = String(req.query.object || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const newest = String(req.query.newest || "1") === "1";

    let query = "SELECT * FROM triples WHERE 1=1";
    const params = [];
    let paramIdx = 1;

    if (subject) {
      query += ` AND subject ILIKE $${paramIdx}`;
      params.push(`%${subject}%`);
      paramIdx++;
    }
    if (predicate) {
      query += ` AND predicate ILIKE $${paramIdx}`;
      params.push(`%${predicate}%`);
      paramIdx++;
    }
    if (object) {
      query += ` AND object ILIKE $${paramIdx}`;
      params.push(`%${object}%`);
      paramIdx++;
    }

    query += ` ORDER BY created_at ${newest ? "DESC" : "ASC"} LIMIT $${paramIdx}`;
    params.push(limit);

    const { rows } = await pool.query(query, params);
    res.json({ count: rows.length, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/admin/ingestion/recent", async (req, res) => {
  try {
    const minutes = Math.min(parseInt(req.query.minutes || "60", 10), 1440);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);

    const { rows } = await pool.query(
      `SELECT crouton_id, source_url, text, created_at 
       FROM croutons 
       WHERE created_at >= NOW() - ($1 || ' minutes')::INTERVAL
       ORDER BY created_at DESC 
       LIMIT $2`,
      [minutes, limit]
    );

    res.json({
      window_minutes: minutes,
      count: rows.length,
      items: rows,
      now: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Static Files =====
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    setHeaders(res, filePath) {
      res.setHeader(
        "Cache-Control",
        filePath.endsWith(".html")
          ? "no-store, no-cache, must-revalidate, max-age=0"
          : "public, max-age=300, stale-while-revalidate=60"
      );
    },
  })
);

// ===== Admin Pages =====
app.get("/dashboard", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "dashboard.html"))
);
app.get("/docs", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "docs.html"))
);
app.get("/", (_req, res) => res.redirect("/dashboard"));

// ===== Boot =====
app.listen(PORT, () => {
  const fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log(`graph-service running on ${PORT} (secret fp: ${fp})`);
});

module.exports = app;
