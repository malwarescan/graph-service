/* jshint node: true, esversion: 11 */

// server.js — Graph API + Admin Tools (Query Search, HMAC Validator, Ingestion Monitor)
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 8080;

// ===== Config =====
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";
const DATABASE_URL = process.env.DATABASE_URL;

// ===== PG =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Railway PG uses SSL; most clients accept defaults. If needed:
  // ssl: { rejectUnauthorized: false }
});

// ===== Helpers =====
function hmacHex(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}

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
    return (got.length === exp.length && crypto.timingSafeEqual(got, exp)) ||
           (got.length === altB.length && crypto.timingSafeEqual(got, altB));
  } catch (e) {
    return false;
  }
}

function ndjsonFromRows(rows) {
  return rows.map(r => JSON.stringify(r)).join("\n") + "\n";
}

function setNdjsonHeaders(res, noCache, body) {
  const etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  if (noCache) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  } else {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  }
  return etag;
}

// ===== Middleware =====
const ndjsonBody = express.text({ type: "*/*", limit: "5mb" });
app.disable("x-powered-by");

// ===== Health =====
app.get("/healthz", function (_req, res) {
  res.setHeader("ETag", '"ok"');
  res.send("ok");
});

// ===== IMPORT (NDJSON + HMAC) =====
app.post("/import", ndjsonBody, async function (req, res) {
  const raw = req.body || "";
  if (!raw) return res.status(400).json({ error: "empty body" });
  if (!verifyHmacHeader(req, raw)) return res.status(401).json({ error: "invalid signature" });

  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return res.status(400).json({ error: "no lines" });

  const MAX_LINE_BYTES = 100000;
  let accepted = 0;
  let skipped = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.length > MAX_LINE_BYTES) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "line too large" });
      }
      let obj;
      try { obj = JSON.parse(line); }
      catch (_e) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "invalid JSON line: " + line.slice(0, 120) + "..." });
      }

      // Required minimum fields
      if (!obj.source_url) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "source_url is required" });
      }

      // Compute source_hash (stable hash of source_url + text + triple JSON)
      const tripleStr = obj.triple ? JSON.stringify(obj.triple) : "";
      const toHash = (obj.source_url || "") + "|" + (obj.text || "") + "|" + tripleStr;
      const source_hash = crypto.createHash("sha256").update(toHash).digest("hex");

      // Upsert crouton
      const q = `
        INSERT INTO croutons (crouton_id, source_url, source_hash, corpus_id, triple, text,
                              confidence, verified_at, context_hash, contextually_verified, verification_meta)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (source_hash) DO NOTHING
        RETURNING id, source_hash
      `;
      const vals = [
        obj.crouton_id || null,
        obj.source_url,
        source_hash,
        obj.corpus_id || null,
        obj.triple ? JSON.stringify(obj.triple) : null,
        obj.text || null,
        obj.confidence != null ? obj.confidence : null,
        obj.verified_at ? new Date(obj.verified_at) : new Date(),
        obj.context_hash || null,
        obj.contextually_verified != null ? obj.contextually_verified : null,
        obj.verification_meta ? JSON.stringify(obj.verification_meta) : null
      ];

      const ins = await client.query(q, vals);
      if (ins.rowCount === 0) {
        skipped += 1;
        continue;
      }
      accepted += 1;

      // If triple present, upsert into triples
      if (obj.triple && obj.triple.subject && obj.triple.predicate && obj.triple.object) {
        await client.query(
          `
          INSERT INTO triples (subject, predicate, object, evidence_crouton_id)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (subject, predicate, object) DO NOTHING
          `,
          [obj.triple.subject, obj.triple.predicate, obj.triple.object, obj.crouton_id || null]
        );
      }
    }
    await client.query("COMMIT");
    return res.json({ accepted, skipped, total: lines.length });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Import failed:", err);
    return res.status(500).json({ error: "import_failed" });
  } finally {
    client.release();
  }
});

// ===== Feeds =====
// /feeds/croutons.ndjson
app.get("/feeds/croutons.ndjson", async function (req, res) {
  const noCache = String(req.query.nocache || "") === "1";
  const { rows } = await pool.query(
    `SELECT id::text, crouton_id, source_url, source_hash, corpus_id, triple, text,
            confidence, verified_at, created_at, context_hash, contextually_verified, verification_meta
     FROM croutons
     ORDER BY created_at ASC`
  );
  const body = ndjsonFromRows(rows);
  const etag = setNdjsonHeaders(res, noCache, body);
  if (req.headers["if-none-match"] === etag && !noCache) return res.status(304).end();
  res.send(body);
});

// /feeds/graph.json
app.get("/feeds/graph.json", async function (req, res) {
  const noCache = String(req.query.nocache || "") === "1";
  const { rows } = await pool.query(
    `SELECT subject, predicate, object, evidence_crouton_id, created_at
     FROM triples
     ORDER BY created_at ASC`
  );
  const payload = { generated_at: new Date().toISOString(), triples: rows };
  const body = JSON.stringify(payload, null, 2);
  const etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (noCache) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  } else {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  }
  if (req.headers["if-none-match"] === etag && !noCache) return res.status(304).end();
  res.send(body);
});

// ===== Diagnostics =====
// schema
app.get("/diag/schema", async function (_req, res) {
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
  );
  const columns = await pool.query(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema='public'
     ORDER BY table_name, ordinal_position`
  );
  res.json({ tables: tables.rows, columns: columns.rows });
});

// stats (ingestion monitor base)
app.get("/diag/stats", async function (_req, res) {
  const [{ rows: cr }] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM croutons")
  ]);
  const tr = await pool.query("SELECT COUNT(*)::int AS n FROM triples");
  res.json({
    ok: true,
    counts: { croutons: cr[0].n, triples: tr.rows[0].n },
    time: new Date().toISOString()
  });
});

// hmac ping + echo
app.get("/diag/ping", function (_req, res) {
  const fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  const payload = "PROBE\n";
  const sig = hmacHex(payload);
  res.json({
    ok: true,
    secret_fingerprint: fp,
    probe_payload_b64: Buffer.from(payload).toString("base64"),
    server_signature_header: "sha256=" + sig
  });
});
app.post("/diag/echo", ndjsonBody, function (req, res) {
  const body = req.body || "";
  const recv = req.get("X-Signature") || "";
  const calc = "sha256=" + hmacHex(body);
  res.json({ bytes: body.length, received_signature: recv, server_signature: calc, matches: recv === calc });
});

// ===== Admin (Query Search + Ingestion Monitor APIs) =====
// GET /admin/search/croutons?text=...&source_url=...&limit=50&newest=1
app.get("/admin/search/croutons", async function (req, res) {
  const text = (req.query.text || "").toString().trim();
  const sourceUrl = (req.query.source_url || "").toString().trim();
  const newest = (req.query.newest || "").toString().trim() === "1";
  let limit = parseInt((req.query.limit || "50").toString(), 10);
  if (!(limit > 0 && limit <= 200)) limit = 50;

  const clauses = [];
  const params = [];
  if (text) { params.push("%" + text + "%"); clauses.push("text ILIKE $" + params.length); }
  if (sourceUrl) { params.push("%" + sourceUrl + "%"); clauses.push("source_url ILIKE $" + params.length); }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const order = newest ? "ORDER BY created_at DESC" : "ORDER BY created_at ASC";
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT crouton_id, source_url, text, triple, confidence, verified_at, created_at
     FROM croutons
     ${where}
     ${order}
     LIMIT $${params.length}`, params
  );
  res.json({ items: rows, count: rows.length });
});

// GET /admin/search/triples?subject=&predicate=&object=&limit=50&newest=1
app.get("/admin/search/triples", async function (req, res) {
  const subj = (req.query.subject || "").toString().trim();
  const pred = (req.query.predicate || "").toString().trim();
  const obj = (req.query.object || "").toString().trim();
  const newest = (req.query.newest || "").toString().trim() === "1";
  let limit = parseInt((req.query.limit || "50").toString(), 10);
  if (!(limit > 0 && limit <= 200)) limit = 50;

  const clauses = [];
  const params = [];
  if (subj) { params.push("%" + subj + "%"); clauses.push("subject ILIKE $" + params.length); }
  if (pred) { params.push("%" + pred + "%"); clauses.push("predicate ILIKE $" + params.length); }
  if (obj) { params.push("%" + obj + "%"); clauses.push("object ILIKE $" + params.length); }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const order = newest ? "ORDER BY created_at DESC" : "ORDER BY created_at ASC";
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT subject, predicate, object, evidence_crouton_id, created_at
     FROM triples
     ${where}
     ${order}
     LIMIT $${params.length}`, params
  );
  res.json({ items: rows, count: rows.length });
});

// GET /admin/ingestion/recent?minutes=60&limit=50
app.get("/admin/ingestion/recent", async function (req, res) {
  const minutes = Math.max(1, Math.min(1440, parseInt((req.query.minutes || "60").toString(), 10) || 60));
  let limit = parseInt((req.query.limit || "50").toString(), 10);
  if (!(limit > 0 && limit <= 500)) limit = 50;

  const { rows } = await pool.query(
    `SELECT crouton_id, source_url, text, created_at
       FROM croutons
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 minute')
      ORDER BY created_at DESC
      LIMIT $2`,
    [minutes, limit]
  );
  res.json({ window_minutes: minutes, items: rows, count: rows.length, now: new Date().toISOString() });
});

// ===== Static Admin UI =====
app.use("/", express.static("public", {
  etag: true,
  setHeaders: function (res, path) {
    // Short cache for HTML, longer for assets if you add any later
    if (path.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    } else {
      res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
    }
  }
}));

// ===== Boot =====
app.listen(PORT, function () {
  const fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log("graph-service running on " + PORT + " (secret fp: " + fp + ")");
});