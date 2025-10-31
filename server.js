/* jshint node: true, esversion: 11 */

// server.js — Truth Hose (DB-backed, HMAC, JSHint-safe, clear import errors)
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 8080;

// ===== Config =====
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";
const DATABASE_URL = process.env.DATABASE_URL || "";

// ===== PG =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Railway Postgres uses SSL; their lib handles it automatically inside container.
});

// ===== Helpers (HMAC) =====
function hmacHex(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}

function verifyHmacHeader(req, body) {
  const header = req.get("X-Signature") || req.get("x-signature") || "";
  if (!header || header.indexOf("sha256=") !== 0) return false;
  const gotHex = header.slice("sha256=".length);

  // Compare against exact body and one newline variant (robust to \n mismatches)
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

// Simple stable source hash (dedupe key): sha256(source_url + '|' + text)
function computeSourceHash(obj) {
  const url = String(obj.source_url || "");
  const text = String(obj.text || "");
  const input = url + "|" + text;
  return crypto.createHash("sha256").update(input).digest("hex");
}

// ISO time guard (loose)
function isIso8601(s) {
  if (!s || typeof s !== "string") return false;
  // Avoid heavy regex; rely on Date parse for sanity
  const d = new Date(s);
  return !isNaN(d.getTime());
}

// ===== In-memory last error for quick diagnostics =====
let __LAST_IMPORT_ERROR = null;

// ===== Middleware =====
const ndjsonBody = express.text({ type: "*/*", limit: "5mb" });
app.disable("x-powered-by");

// ===== Health =====
app.get("/healthz", function (_req, res) {
  res.send("ok");
});

// ===== Diagnostics: DB schema + last import error =====
app.get("/diag/schema", async function (_req, res) {
  try {
    const tables = await pool.query(
      "select table_name from information_schema.tables where table_schema='public' order by table_name;"
    );
    const cols = await pool.query(
      "select table_name, column_name, data_type from information_schema.columns where table_schema='public' order by table_name, ordinal_position;"
    );
    res.json({ tables: tables.rows, columns: cols.rows, last_import_error: __LAST_IMPORT_ERROR });
  } catch (e) {
    res.status(500).json({ error: "schema_failed", detail: String(e.message || e) });
  }
});

// ===== Import (NDJSON, HMAC required) =====
app.post("/import", ndjsonBody, async function (req, res) {
  const raw = req.body || "";
  if (!raw) return res.status(400).json({ error: "empty_body" });

  if (!verifyHmacHeader(req, raw)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return res.status(400).json({ error: "no_lines" });

  const MAX_LINE_BYTES = 100000; // 100 KB per line
  let accepted = 0;
  let skipped = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > MAX_LINE_BYTES) {
        throw new Error("line_too_large");
      }

      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        throw new Error("invalid_json_line");
      }

      // Validate required fields
      if (!obj.source_url || typeof obj.source_url !== "string") {
        throw new Error("missing_source_url");
      }
      if (!obj.text || typeof obj.text !== "string") {
        throw new Error("missing_text");
      }
      if (!obj.verified_at || !isIso8601(obj.verified_at)) {
        throw new Error("invalid_verified_at");
      }

      // Ensure a dedupe hash
      if (!obj.source_hash) {
        obj.source_hash = computeSourceHash(obj);
      }

      // Optional fields with sane defaults
      const crouton_id = obj.crouton_id || null;
      const corpus_id = obj.corpus_id || null;
      const triple = obj.triple ? JSON.stringify(obj.triple) : null;
      const confidence = (obj.confidence === 0 || obj.confidence) ? Number(obj.confidence) : null;
      const verified_at = obj.verified_at;
      const context_hash = obj.context_hash || null;
      const contextually_verified = typeof obj.contextually_verified === "boolean" ? obj.contextually_verified : null;
      const verification_meta = obj.verification_meta ? JSON.stringify(obj.verification_meta) : null;

      // Insert with dedupe on (source_hash)
      // 003/004 migration should have a UNIQUE INDEX on source_hash WHERE source_hash IS NOT NULL
      const insertSql =
        "insert into croutons (crouton_id, source_url, source_hash, corpus_id, triple, text, confidence, verified_at, context_hash, contextually_verified, verification_meta) " +
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) " +
        "on conflict (source_hash) do nothing " +
        "returning id;";

      const params = [
        crouton_id,
        obj.source_url,
        obj.source_hash,
        corpus_id,
        triple,
        obj.text,
        confidence,
        verified_at,
        context_hash,
        contextually_verified,
        verification_meta
      ];

      const r = await client.query(insertSql, params);
      if (r.rowCount > 0) {
        accepted += 1;
      } else {
        skipped += 1; // deduped
      }

      // If triple present, record it (best-effort)
      if (obj.triple && obj.triple.subject && obj.triple.predicate && obj.triple.object) {
        const evId = crouton_id || null;
        await client.query(
          "insert into triples (subject, predicate, object, evidence_crouton_id) values ($1,$2,$3,$4);",
          [obj.triple.subject, obj.triple.predicate, obj.triple.object, evId]
        );
      }
    }

    await client.query("COMMIT");
    __LAST_IMPORT_ERROR = null;
    return res.json({ accepted: accepted, skipped: skipped, total: lines.length });
  } catch (err) {
    await client.query("ROLLBACK").catch(function () {});
    __LAST_IMPORT_ERROR = {
      message: String(err.message || err),
      // leave out stack to keep response small and safe
    };
    return res.status(500).json({
      error: "import_failed",
      detail: __LAST_IMPORT_ERROR.message
    });
  } finally {
    client.release();
  }
});

// ===== Feeds (DB-backed) =====
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

app.get("/feeds/croutons.ndjson", async function (req, res) {
  const noCache = String(req.query.nocache || "") === "1";
  try {
    const r = await pool.query(
      "select crouton_id, source_url, source_hash, corpus_id, triple, text, confidence, verified_at, context_hash, contextually_verified, verification_meta " +
      "from croutons order by created_at asc;"
    );
    const rows = r.rows.map(function (row) {
      const o = {
        crouton_id: row.crouton_id,
        source_url: row.source_url,
        source_hash: row.source_hash,
        corpus_id: row.corpus_id,
        triple: row.triple,
        text: row.text,
        confidence: row.confidence,
        verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null,
        context_hash: row.context_hash,
        contextually_verified: row.contextually_verified,
        verification_meta: row.verification_meta
      };
      return JSON.stringify(o);
    });
    const body = rows.join("\n") + "\n";
    const etag = setNdjsonHeaders(res, noCache, body);
    if (req.headers["if-none-match"] === etag && !noCache) {
      return res.status(304).end();
    }
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: "feed_failed", detail: String(e.message || e) });
  }
});

app.get("/feeds/corpora.ndjson", async function (req, res) {
  const noCache = String(req.query.nocache || "") === "1";
  try {
    // Group in SQL for scale
    const r = await pool.query(
      "select coalesce(corpus_id, 'default') as corpus_id, json_agg(json_build_object(" +
        "'crouton_id', crouton_id, " +
        "'source_url', source_url, " +
        "'source_hash', source_hash, " +
        "'triple', triple, " +
        "'text', text, " +
        "'confidence', confidence, " +
        "'verified_at', verified_at, " +
        "'context_hash', context_hash, " +
        "'contextually_verified', contextually_verified, " +
        "'verification_meta', verification_meta" +
      ")) as croutons " +
      "from croutons group by coalesce(corpus_id, 'default') " +
      "order by coalesce(corpus_id, 'default');"
    );

    const rows = r.rows.map(function (row) {
      // Normalize ISO
      const list = (row.croutons || []).map(function (c) {
        if (c && c.verified_at) {
          c.verified_at = new Date(c.verified_at).toISOString();
        }
        return c;
      });
      return JSON.stringify({ corpus_id: row.corpus_id, croutons: list });
    });

    const body = rows.join("\n") + "\n";
    const etag = setNdjsonHeaders(res, noCache, body);
    if (req.headers["if-none-match"] === etag && !noCache) {
      return res.status(304).end();
    }
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: "feed_failed", detail: String(e.message || e) });
  }
});

app.get("/feeds/graph.json", async function (req, res) {
  const noCache = String(req.query.nocache || "") === "1";
  try {
    const r = await pool.query(
      "select subject, predicate, object, evidence_crouton_id, created_at from triples order by created_at asc;"
    );
    const payload = {
      generated_at: new Date().toISOString(),
      triples: r.rows
    };
    const body = JSON.stringify(payload, null, 2);
    const etag = crypto.createHash("sha256").update(body).digest("hex");
    res.setHeader("ETag", etag);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (noCache) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    } else {
      res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
    }
    if (req.headers["if-none-match"] === etag && !noCache) {
      return res.status(304).end();
    }
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: "feed_failed", detail: String(e.message || e) });
  }
});

// ===== Boot =====
app.listen(PORT, function () {
  const fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log("graph-service running on " + PORT + " (secret fp: " + fp + ")");
});