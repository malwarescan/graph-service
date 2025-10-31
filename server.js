/* jshint node: true, esversion: 11 */

// server.js — Graph Service (HMAC import + Postgres persistence + feeds + diag)
const express = require("express");
const crypto  = require("crypto");
const app     = express();

const PORT = process.env.PORT || 8080;

// ===== Config =====
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";

// ===== DB Helper =====
let db = null;
try {
  db = require("./db"); // expects db.js present (Pool with DATABASE_URL)
} catch (_e) {
  // allow boot without db.js for local dry runs, but warn
  console.warn("db.js not found or failed to load. DB features may not work.");
}

// ===== In-memory stores (used for feeds; DB is the source of truth) =====
global.__CROUTONS = global.__CROUTONS || [];
global.__CORPORA  = global.__CORPORA  || [];
global.__GRAPH    = global.__GRAPH    || [];

// ===== Helpers (HMAC) =====
function hmacHex(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}

function verifyHmacHeader(req, body) {
  var header = req.get("X-Signature") || req.get("x-signature") || "";
  if (!header || header.indexOf("sha256=") !== 0) return false;
  var gotHex = header.slice("sha256=".length);

  // Compare exact body and newline-variant body (robust to \n differences)
  var exact = hmacHex(body);
  var alt   = body.endsWith("\n") ? hmacHex(body.slice(0, -1)) : hmacHex(body + "\n");

  try {
    var got  = Buffer.from(gotHex, "hex");
    var exp  = Buffer.from(exact,  "hex");
    var altB = Buffer.from(alt,    "hex");
    var a = (got.length === exp.length && crypto.timingSafeEqual(got, exp));
    var b = (got.length === altB.length && crypto.timingSafeEqual(got, altB));
    return a || b;
  } catch (_e) {
    return false;
  }
}

// ===== Derive feeds from memory =====
function rebuildFeeds() {
  var croutons = global.__CROUTONS || [];

  // Corpora
  var corporaMap = new Map();
  for (var i = 0; i < croutons.length; i++) {
    var c = croutons[i];
    var cid = c.corpus_id || "default";
    if (!corporaMap.has(cid)) corporaMap.set(cid, []);
    corporaMap.get(cid).push(c);
  }
  global.__CORPORA = Array.from(corporaMap.entries()).map(function (entry) {
    return { corpus_id: entry[0], croutons: entry[1] };
  });

  // Simple triples graph from croutons with { triple:{subject,predicate,object} }
  var triples = [];
  var t = 0;
  for (var j = 0; j < croutons.length; j++) {
    var cc = croutons[j];
    if (cc.triple && cc.triple.subject && cc.triple.predicate && cc.triple.object) {
      triples.push({
        triple_id: "trp_" + (t++),
        subject: cc.triple.subject,
        predicate: cc.triple.predicate,
        object: cc.triple.object,
        evidence: [cc.crouton_id || null].filter(Boolean)
      });
    }
  }
  global.__GRAPH = triples;
}

// ===== Middleware =====
// Only let /import accept raw text (NDJSON). 5 MB cap is plenty for batches.
const ndjsonBody = express.text({ type: "*/*", limit: "5mb" });

// Minimal hardening headers
app.disable("x-powered-by");

// ===== Health =====
app.get("/healthz", function (_req, res) {
  res.send("ok");
});

// ===== Import (NDJSON, HMAC required, persists to Postgres) =====
app.post("/import", ndjsonBody, async function (req, res) {
  var raw = req.body || "";
  if (!raw) return res.status(400).json({ error: "empty body" });

  if (!verifyHmacHeader(req, raw)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  // Split NDJSON
  var lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return res.status(400).json({ error: "no lines" });

  var MAX_LINE_BYTES = 100000; // 100 KB per line
  var batch = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.length > MAX_LINE_BYTES) {
      return res.status(413).json({ error: "line too large" });
    }
    try {
      var obj = JSON.parse(line);
      batch.push(obj);
    } catch (_e) {
      return res.status(400).json({ error: "invalid JSON line: " + line.slice(0, 120) + "..." });
    }
  }

  // Insert into Postgres (best-effort; continue on single-row failures)
  if (db && db.query) {
    var insertQuery =
      "INSERT INTO croutons (crouton_id, source_url, source_hash, corpus_id, triple, text, confidence, verified_at, context_hash, contextually_verified, verification_meta) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) " +
      "ON CONFLICT (crouton_id) DO NOTHING;";

    for (var k = 0; k < batch.length; k++) {
      var c = batch[k];
      var vals = [
        c.crouton_id || null,
        c.source_url || null,
        c.source_hash || null,
        c.corpus_id || null,
        c.triple ? JSON.stringify(c.triple) : null,
        c.text || null,
        c.confidence || null,
        c.verified_at ? new Date(c.verified_at) : new Date(),
        c.context_hash || null,
        c.contextually_verified || false,
        c.verification_meta ? JSON.stringify(c.verification_meta) : null
      ];
      try {
        // eslint-disable-next-line no-await-in-loop
        await db.query(insertQuery, vals);
      } catch (e) {
        console.error("DB insert error:", e.message);
      }
    }
  } else {
    console.warn("DB not available — skipping persistence for this batch.");
  }

  // Keep in-memory for feeds
  Array.prototype.push.apply(global.__CROUTONS, batch);
  rebuildFeeds();

  return res.json({ accepted: batch.length });
});

// ===== Feeds (ETag + nocache aware) =====
function setNdjsonHeaders(res, noCache, body) {
  var etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  if (noCache) {
    // expanded if/else to avoid JSHint W014 complaining about ternary line breaks
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  } else {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  }
  return etag;
}

// /feeds/croutons.ndjson
app.get("/feeds/croutons.ndjson", function (req, res) {
  var noCache = String(req.query.nocache || "") === "1";
  var rows = (global.__CROUTONS || []).map(function (o) { return JSON.stringify(o); });
  var body = rows.join("\n") + "\n";

  var etag = setNdjsonHeaders(res, noCache, body);
  if (req.headers["if-none-match"] === etag && !noCache) {
    return res.status(304).end();
  }
  res.send(body);
});

// /feeds/corpora.ndjson
app.get("/feeds/corpora.ndjson", function (req, res) {
  var noCache = String(req.query.nocache || "") === "1";
  var rows = (global.__CORPORA || []).map(function (o) { return JSON.stringify(o); });
  var body = rows.join("\n") + "\n";

  var etag = setNdjsonHeaders(res, noCache, body);
  if (req.headers["if-none-match"] === etag && !noCache) {
    return res.status(304).end();
  }
  res.send(body);
});

// /feeds/graph.json
app.get("/feeds/graph.json", function (req, res) {
  var noCache = String(req.query.nocache || "") === "1";
  var payload = {
    generated_at: new Date().toISOString(),
    triples: global.__GRAPH || []
  };
  var body = JSON.stringify(payload, null, 2);

  var etag = crypto.createHash("sha256").update(body).digest("hex");
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
});

// ===== Diagnostics: Schema (used earlier) =====
app.get("/diag/schema", async function (_req, res) {
  if (!db || !db.query) return res.status(503).json({ error: "db_unavailable" });
  try {
    var tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;"
    );
    var cols = await db.query(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position;"
    );
    res.json({ tables: tables.rows, columns: cols.rows });
  } catch (e) {
    res.status(500).json({ error: "schema_introspection_failed", detail: e.message });
  }
});

// ===== Boot =====
app.listen(PORT, function () {
  var fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log("graph-service running on " + PORT + " (secret fp: " + fp + ")");
});