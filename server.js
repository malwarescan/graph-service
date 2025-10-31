/* jshint node: true, esversion: 11 */
"use strict";

// server.js — Graph Service (DB-backed Truth Hose + Feeds + Diag)
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

// ===== Config =====
const PORT = process.env.PORT || 8080;
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";
const DATABASE_URL = process.env.DATABASE_URL || "";

// PG pool (Railway Postgres usually needs SSL)
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !DATABASE_URL.includes("localhost") ? { rejectUnauthorized: false } : false
});

// ===== App =====
const app = express();
app.disable("x-powered-by");

// Only let /import accept raw text (NDJSON). 5 MB cap is plenty for batches.
const ndjsonBody = express.text({ type: "*/*", limit: "5mb" });

// ===== Helpers (HMAC & hashing) =====
function hmacHex(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}

// Accept exact body and single newline variant to avoid signing \n mismatches
function verifyHmacHeader(req, body) {
  const header = req.get("X-Signature") || req.get("x-signature") || "";
  if (!header || header.indexOf("sha256=") !== 0) return false;
  const gotHex = header.slice("sha256=".length);

  const exact = hmacHex(body);
  const alt = body.endsWith("\n") ? hmacHex(body.slice(0, -1)) : hmacHex(body + "\n");

  try {
    const got = Buffer.from(gotHex, "hex");
    const exp = Buffer.from(exact, "hex");
    const altB = Buffer.from(alt, "hex");
    const matchExact = got.length === exp.length && crypto.timingSafeEqual(got, exp);
    const matchAlt = got.length === altB.length && crypto.timingSafeEqual(got, altB);
    return matchExact || matchAlt;
  } catch (_e) {
    return false;
  }
}

// Deterministic content hash (used for idempotency & ON CONFLICT)
function computeSourceHash(obj) {
  // Hash over stable fields likely to represent the same atomic fact
  const payload = JSON.stringify({
    source_url: obj.source_url || "",
    text: obj.text || "",
    triple: obj.triple || null,
    corpus_id: obj.corpus_id || null,
    verified_at: obj.verified_at || null
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ===== Health =====
app.get("/healthz", function (_req, res) {
  res.send("ok");
});

// ===== Import (NDJSON, HMAC, DB-backed) =====
app.post("/import", ndjsonBody, async function (req, res) {
  const raw = req.body || "";
  if (!raw) return res.status(400).json({ error: "empty body" });
  if (!verifyHmacHeader(req, raw)) return res.status(401).json({ error: "invalid signature" });

  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return res.status(400).json({ error: "no lines" });

  const MAX_LINE_BYTES = 100000; // 100 KB per line
  const batch = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE_BYTES) return res.status(413).json({ error: "line too large" });

    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      return res.status(400).json({ error: "invalid JSON line: " + line.slice(0, 120) + "..." });
    }

    // Required minimal fields for persistence
    if (!obj.source_url || !obj.text) {
      return res.status(400).json({ error: "source_url and text are required" });
    }

    obj.source_hash = computeSourceHash(obj);
    batch.push(obj);
  }

  const client = await pool.connect();
  try {
    let accepted = 0;
    let skipped = 0;

    // Insert each row; skip duplicates on source_hash
    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];

      const q = `
        INSERT INTO croutons
          (id, crouton_id, source_url, source_hash, corpus_id, triple, text, confidence, verified_at, created_at, context_hash, contextually_verified, verification_meta)
        VALUES
          (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8, NOW(), $9, $10, $11::jsonb)
        ON CONFLICT (source_hash)
        DO NOTHING
        RETURNING id
      `;
      const vals = [
        c.crouton_id || null,
        c.source_url,
        c.source_hash,
        c.corpus_id || null,
        c.triple ? JSON.stringify(c.triple) : null,
        c.text,
        c.confidence != null ? Number(c.confidence) : null,
        c.verified_at ? new Date(c.verified_at) : null,
        c.context_hash || null,
        c.contextually_verified != null ? !!c.contextually_verified : null,
        c.verification_meta ? JSON.stringify(c.verification_meta) : null
      ];

      const r = await client.query(q, vals);
      if (r.rowCount > 0) {
        accepted += 1;
      } else {
        skipped += 1;
      }
    }

    res.json({ accepted, skipped, total: batch.length });
  } catch (err) {
    console.error("Import failed:", err);
    res.status(500).json({ error: "import_failed" });
  } finally {
    client.release();
  }
});

// ===== Feeds (DB-backed) =====
function setNdjsonHeaders(res, noCache, body) {
  const etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  const cacheControl = noCache ? "no-store, no-cache, must-revalidate, max-age=0" : "public, max-age=300, stale-while-revalidate=60";
  res.setHeader("Cache-Control", cacheControl);
  return etag;
}

// /feeds/croutons.ndjson
app.get("/feeds/croutons.ndjson", async function (req, res) {
  const noCache = String(req.query.nocache || "") === "1";
  try {
    const q = `
      SELECT crouton_id, source_url, source_hash, corpus_id, triple, text, confidence, verified_at, context_hash, contextually_verified, verification_meta
      FROM croutons
      ORDER BY created_at ASC
    `;
    const r = await pool.query(q);
    const rows = r.rows.map(function (row) {
      return JSON.stringify({
        crouton_id: row.crouton_id || null,
        source_url: row.source_url || null,
        source_hash: row.source_hash || null,
        corpus_id: row.corpus_id || null,
        triple: row.triple || null,
        text: row.text || null,
        confidence: row.confidence != null ? Number(row.confidence) : null,
        verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null,
        context_hash: row.context_hash || null,
        contextually_verified: row.contextually_verified != null ? !!row.contextually_verified : null,
        verification_meta: row.verification_meta || null
      });
    });

    const body = rows.join("\n") + "\n";
    const etag = setNdjsonHeaders(res, noCache, body);
    if (req.headers["if-none-match"] === etag && !noCache) {
      return res.status(304).end();
    }
    res.send(body);
  } catch (err) {
    console.error("Feed croutons error:", err);
    res.status(500).json({ error: "feed_failed" });
  }
});

// /feeds/corpora.ndjson
app.get("/feeds/corpora.ndjson", async function (req, res) {
  const noCache = String(req.query.nocache || "") === "1";
  try {
    const q = `
      SELECT crouton_id, source_url, source_hash, corpus_id, triple, text, confidence, verified_at, context_hash, contextually_verified, verification_meta
      FROM croutons
      ORDER BY created_at ASC
    `;
    const r = await pool.query(q);

    // Group by corpus_id (default to "default")
    const map = new Map();
    for (let i = 0; i < r.rows.length; i++) {
      const row = r.rows[i];
      const cid = row.corpus_id || "default";
      if (!map.has(cid)) map.set(cid, []);
      map.get(cid).push(row);
    }

    const lines = [];
    map.forEach(function (list, corpus_id) {
      lines.push(JSON.stringify({ corpus_id: corpus_id, croutons: list }));
    });

    const body = lines.join("\n") + "\n";
    const etag = setNdjsonHeaders(res, noCache, body);
    if (req.headers["if-none-match"] === etag && !noCache) {
      return res.status(304).end();
    }
    res.send(body);
  } catch (err) {
    console.error("Feed corpora error:", err);
    res.status(500).json({ error: "feed_failed" });
  }
});

// /feeds/graph.json
app.get("/feeds/graph.json", async function (req, res) {
  const noCache = String(req.query.nocache || "") === "1";
  try {
    const r = await pool.query(`
      SELECT subject, predicate, object, evidence_crouton_id, created_at
      FROM triples
      ORDER BY created_at ASC
    `);

    const payload = {
      generated_at: new Date().toISOString(),
      triples: r.rows.map(function (t, i) {
        return {
          triple_id: "trp_" + i,
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          evidence: t.evidence_crouton_id ? [t.evidence_crouton_id] : []
        };
      })
    };

    const body = JSON.stringify(payload, null, 2);
    const etag = crypto.createHash("sha256").update(body).digest("hex");
    res.setHeader("ETag", etag);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const cacheControl = noCache ? "no-store, no-cache, must-revalidate, max-age=0" : "public, max-age=300, stale-while-revalidate=60";
    res.setHeader("Cache-Control", cacheControl);

    if (req.headers["if-none-match"] === etag && !noCache) {
      return res.status(304).end();
    }
    res.send(body);
  } catch (err) {
    console.error("Feed graph error:", err);
    res.status(500).json({ error: "feed_failed" });
  }
});

// ===== Diagnostics (keep: schema) =====
app.get("/diag/schema", async function (_req, res) {
  try {
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const cols = await pool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);
    res.json({ tables: tables.rows, columns: cols.rows });
  } catch (err) {
    console.error("diag/schema error:", err);
    res.status(500).json({ error: "diag_failed" });
  }
});

// ===== Boot =====
app.listen(PORT, function () {
  const fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log("graph-service running on " + PORT + " (secret fp: " + fp + ")");
});