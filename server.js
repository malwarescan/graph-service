/* jshint node: true, esversion: 11 */
"use strict";

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8080;
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn("[warn] DATABASE_URL not set.");
}

const pool = new Pool({ connectionString: DATABASE_URL });
const app = express();
app.disable("x-powered-by");

// Only /import accepts raw text (NDJSON)
const ndjsonBody = express.text({ type: "*/*", limit: "5mb" });

// ===== Helpers =====
function hmacHex(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}

function verifyHmacHeader(req, body) {
  const header = req.get("X-Signature") || req.get("x-signature") || "";
  if (!header || header.indexOf("sha256=") !== 0) return false;
  const gotHex = header.slice("sha256=".length);

  const exact = hmacHex(body);
  const alt   = body.endsWith("\n") ? hmacHex(body.slice(0, -1)) : hmacHex(body + "\n");

  try {
    const got  = Buffer.from(gotHex, "hex");
    const exp  = Buffer.from(exact,  "hex");
    const altB = Buffer.from(alt,    "hex");
    return (got.length === exp.length && crypto.timingSafeEqual(got, exp)) ||
           (got.length === altB.length && crypto.timingSafeEqual(got, altB));
  } catch (e) {
    return false;
  }
}

function etagFor(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function setNdjsonHeaders(res, noCache, body) {
  const etag = etagFor(body);
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  if (noCache) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  } else {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  }
  return etag;
}

function setJsonHeaders(res, noCache, body) {
  const etag = etagFor(body);
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (noCache) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  } else {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  }
  return etag;
}

// ===== Routes =====
app.get("/healthz", function (_req, res) {
  res.send("ok");
});

// Import NDJSON (DB-backed) + write triples when present
app.post("/import", ndjsonBody, async function (req, res) {
  const raw = req.body || "";
  if (!raw) return res.status(400).json({ error: "empty body" });

  if (!verifyHmacHeader(req, raw)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return res.status(400).json({ error: "no lines" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let accepted = 0;
    let skipped  = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // sanity cap
      if (line.length > 100000) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "line too large" });
      }

      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "invalid JSON line: " + line.slice(0, 120) + "..." });
      }

      if (!obj.source_url) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "missing source_url" });
      }

      const sourceHash = crypto.createHash("sha256").update(obj.source_url).digest("hex");

      // Insert crouton (dedupe by source_hash)
      const insCrouton = `
        INSERT INTO croutons
          (crouton_id, source_url, source_hash, corpus_id, triple, text, confidence,
           verified_at, context_hash, contextually_verified, verification_meta)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (source_hash) DO NOTHING
        RETURNING id
      `;
      const valsCrouton = [
        obj.crouton_id || null,
        obj.source_url,
        sourceHash,
        obj.corpus_id || null,
        obj.triple ? JSON.stringify(obj.triple) : null,
        obj.text || null,
        obj.confidence == null ? null : obj.confidence,
        obj.verified_at ? new Date(obj.verified_at) : null,
        obj.context_hash || null,
        obj.contextually_verified == null ? null : !!obj.contextually_verified,
        obj.verification_meta ? JSON.stringify(obj.verification_meta) : null
      ];
      const r1 = await client.query(insCrouton, valsCrouton);
      if (r1.rowCount === 1) accepted++; else skipped++;

      // If triple exists, insert into triples with dedupe on (subject,predicate,object)
      if (obj.triple && obj.triple.subject && obj.triple.predicate && obj.triple.object) {
        const insTriple = `
          INSERT INTO triples (subject, predicate, object, evidence_crouton_id)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (subject, predicate, object) DO NOTHING
        `;
        await client.query(insTriple, [
          String(obj.triple.subject),
          String(obj.triple.predicate),
          String(obj.triple.object),
          obj.crouton_id || null
        ]);
      }
    }

    await client.query("COMMIT");
    return res.json({ accepted: accepted, skipped: skipped, total: accepted + skipped });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (e) {}
    console.error("import_failed:", err);
    return res.status(500).json({ error: "import_failed" });
  } finally {
    client.release();
  }
});

// Feeds: croutons.ndjson (DB-backed)
app.get("/feeds/croutons.ndjson", async function (req, res) {
  const noCache = String(req.query.nocache || "") === "1";
  const q = `
    SELECT crouton_id, source_url, source_hash, corpus_id, triple, text,
           confidence, verified_at, created_at, context_hash,
           contextually_verified, verification_meta
    FROM croutons
    ORDER BY created_at ASC
  `;
  const r = await pool.query(q);
  const body = r.rows.map(function (o) { return JSON.stringify(o); }).join("\n") + "\n";
  const etag = setNdjsonHeaders(res, noCache, body);
  if (req.headers["if-none-match"] === etag && !noCache) {
    return res.status(304).end();
  }
  res.send(body);
});

// Feeds: graph.json (DB-backed)
app.get("/feeds/graph.json", async function (req, res) {
  const noCache = String(req.query.nocache || "") === "1";
  const q = `
    SELECT subject, predicate, object, evidence_crouton_id, created_at
    FROM triples
    ORDER BY created_at ASC
  `;
  const r = await pool.query(q);
  const payload = { generated_at: new Date().toISOString(), triples: r.rows };
  const body = JSON.stringify(payload, null, 2);
  const etag = etagFor(body);
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const cacheControl = noCache ? "no-store, no-cache, must-revalidate, max-age=0"
    : "public, max-age=300, stale-while-revalidate=60";
  res.setHeader("Cache-Control", cacheControl);
  if (req.headers["if-none-match"] === etag && !noCache) {
    return res.status(304).end();
  }
  res.send(body);
});

// Diagnostics
app.get("/diag/stats", async function (_req, res) {
  const c1 = await pool.query("SELECT COUNT(*)::int AS n FROM croutons");
  const c2 = await pool.query("SELECT COUNT(*)::int AS n FROM triples");
  res.json({
    ok: true,
    counts: { croutons: c1.rows[0].n, triples: c2.rows[0].n },
    time: new Date().toISOString()
  });
});

app.get("/diag/schema", async function (_req, res) {
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' ORDER BY table_name
  `);
  const columns = await pool.query(`
    SELECT table_name,column_name,data_type
    FROM information_schema.columns
    WHERE table_schema='public' ORDER BY table_name,ordinal_position
  `);
  res.json({ tables: tables.rows, columns: columns.rows });
});

// ===== Boot =====
app.listen(PORT, function () {
  const fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log("graph-service running on " + PORT + " (secret fp: " + fp + ")");
});