/* jshint node: true, esversion: 11 */

// server.js — Truth Hose (DB-backed)
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 8080;

// ===== Config =====
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";
const DATABASE_URL = process.env.DATABASE_URL;

// ===== DB =====
if (!DATABASE_URL) {
  // Fail fast if not configured (it is set in Railway)
  console.error("Missing DATABASE_URL");
  process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL });

// ===== Helpers =====
function hmacHex(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}

function verifyHmacHeader(req, body) {
  const header = req.get("X-Signature") || req.get("x-signature") || "";
  if (!header || header.indexOf("sha256=") !== 0) return false;
  const gotHex = header.slice("sha256=".length);

  // Compare against exact body and one newline variant (robust to \n mismatches)
  const exact = hmacHex(body);
  const alt   = body.endsWith("\n") ? hmacHex(body.slice(0, -1)) : hmacHex(body + "\n");

  try {
    const got  = Buffer.from(gotHex, "hex");
    const exp  = Buffer.from(exact,  "hex");
    const altB = Buffer.from(alt,    "hex");
    var eqExact = (got.length === exp.length) && crypto.timingSafeEqual(got, exp);
    var eqAlt   = (got.length === altB.length) && crypto.timingSafeEqual(got, altB);
    return eqExact || eqAlt;
  } catch (e) {
    return false;
  }
}

function setNdjsonHeaders(res, noCache, etagSource) {
  // Compute an ETag for conditional GETs
  var etag = crypto.createHash("sha256").update(etagSource).digest("hex");
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
  res.send("ok");
});

// ===== Import (NDJSON -> DB, HMAC required) =====
app.post("/import", ndjsonBody, async function (req, res) {
  var raw = req.body || "";
  if (!raw) return res.status(400).json({ error: "empty body" });
  if (!verifyHmacHeader(req, raw)) return res.status(401).json({ error: "invalid signature" });

  var lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return res.status(400).json({ error: "no lines" });

  var MAX_LINE_BYTES = 100000; // 100 KB per line
  var client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    var accepted = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.length > MAX_LINE_BYTES) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "line too large" });
      }

      var obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "invalid JSON line: " + line.slice(0, 120) + "..." });
      }

      // Normalize fields that exist in schema
      var croutonId = obj.crouton_id || null;
      var sourceUrl = obj.source_url || null;
      var sourceHash = obj.source_hash || null;
      var corpusId = obj.corpus_id || null;
      var text = obj.text || null;
      var confidence = (typeof obj.confidence === "number") ? obj.confidence : null;
      var verifiedAt = obj.verified_at ? new Date(obj.verified_at) : null;
      var contextHash = obj.context_hash || null;
      var contextuallyVerified = (typeof obj.contextually_verified === "boolean") ? obj.contextually_verified : null;
      var verificationMeta = obj.verification_meta || null;
      var triple = obj.triple || null;

      // Insert crouton
      await client.query(
        "INSERT INTO croutons " +
        "(crouton_id, source_url, source_hash, corpus_id, triple, text, confidence, verified_at, context_hash, contextually_verified, verification_meta) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          croutonId,
          sourceUrl,
          sourceHash,
          corpusId,
          triple, // jsonb
          text,
          confidence,
          verifiedAt,
          contextHash,
          contextuallyVerified,
          verificationMeta
        ]
      );

      // If triple present, add to triples table for graph feed
      if (triple && triple.subject && triple.predicate && triple.object) {
        await client.query(
          "INSERT INTO triples (subject, predicate, object, evidence_crouton_id) VALUES ($1,$2,$3,$4)",
          [triple.subject, triple.predicate, triple.object, croutonId]
        );
      }

      accepted += 1;
    }

    await client.query("COMMIT");
    return res.json({ accepted: accepted });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (e) {}
    }
    console.error("Import failed:", err);
    return res.status(500).json({ error: "import_failed" });
  } finally {
    if (client) client.release();
  }
});

// ===== Feeds (DB-backed) =====

// /feeds/croutons.ndjson
app.get("/feeds/croutons.ndjson", async function (req, res) {
  var noCache = String(req.query.nocache || "") === "1";
  var client;
  try {
    client = await pool.connect();
    // Stream in memory for simplicity; data volumes are small initially
    var rows = await client.query(
      "SELECT crouton_id, source_url, source_hash, corpus_id, triple, text, confidence, verified_at, context_hash, contextually_verified, verification_meta " +
      "FROM croutons ORDER BY created_at ASC"
    );
    var out = "";
    for (var i = 0; i < rows.rows.length; i++) {
      out += JSON.stringify(rows.rows[i]) + "\n";
    }
    var etag = setNdjsonHeaders(res, noCache, out);
    if (req.headers["if-none-match"] === etag && !noCache) {
      return res.status(304).end();
    }
    res.send(out || "\n");
  } catch (err) {
    console.error("croutons.ndjson error:", err);
    res.status(500).json({ error: "feed_failed" });
  } finally {
    if (client) client.release();
  }
});

// /feeds/corpora.ndjson (group by corpus_id)
app.get("/feeds/corpora.ndjson", async function (req, res) {
  var noCache = String(req.query.nocache || "") === "1";
  var client;
  try {
    client = await pool.connect();
    var rows = await client.query(
      "SELECT corpus_id, json_agg(json_build_object(" +
        "'crouton_id', crouton_id," +
        "'source_url', source_url," +
        "'source_hash', source_hash," +
        "'triple', triple," +
        "'text', text," +
        "'confidence', confidence," +
        "'verified_at', verified_at," +
        "'context_hash', context_hash," +
        "'contextually_verified', contextually_verified," +
        "'verification_meta', verification_meta" +
      ")) AS croutons " +
      "FROM croutons " +
      "GROUP BY corpus_id " +
      "ORDER BY corpus_id NULLS LAST"
    );

    var out = "";
    for (var i = 0; i < rows.rows.length; i++) {
      // Each line: { corpus_id, croutons: [...] }
      var line = {
        corpus_id: rows.rows[i].corpus_id || "default",
        croutons: rows.rows[i].croutons || []
      };
      out += JSON.stringify(line) + "\n";
    }

    var etag = setNdjsonHeaders(res, noCache, out);
    if (req.headers["if-none-match"] === etag && !noCache) {
      return res.status(304).end();
    }
    res.send(out || "\n");
  } catch (err) {
    console.error("corpora.ndjson error:", err);
    res.status(500).json({ error: "feed_failed" });
  } finally {
    if (client) client.release();
  }
});

// /feeds/graph.json (triples snapshot)
app.get("/feeds/graph.json", async function (req, res) {
  var noCache = String(req.query.nocache || "") === "1";
  var client;
  try {
    client = await pool.connect();
    var rows = await client.query(
      "SELECT subject, predicate, object, evidence_crouton_id FROM triples ORDER BY created_at ASC"
    );

    var payload = {
      generated_at: new Date().toISOString(),
      triples: rows.rows || []
    };
    var body = JSON.stringify(payload, null, 2);

    var etag = crypto.createHash("sha256").update(body).digest("hex");
    res.setHeader("ETag", etag);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    var cacheControl = noCache ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60";
    res.setHeader("Cache-Control", cacheControl);

    if (req.headers["if-none-match"] === etag && !noCache) {
      return res.status(304).end();
    }
    res.send(body);
  } catch (err) {
    console.error("graph.json error:", err);
    res.status(500).json({ error: "feed_failed" });
  } finally {
    if (client) client.release();
  }
});

// ===== Boot =====
app.listen(PORT, function () {
  var fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log("graph-service running on " + PORT + " (secret fp: " + fp + ")");
});