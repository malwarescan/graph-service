/* jshint node: true, esversion: 11 */

// server.js (CommonJS) — Truth Hose (prod-ready, no diagnostics)
const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

// ===== Config =====
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";

// ===== In-memory stores (replace with Postgres later) =====
global.__CROUTONS = global.__CROUTONS || [];
global.__CORPORA  = global.__CORPORA  || [];
global.__GRAPH    = global.__GRAPH    || [];

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
    return (got.length === exp.length && crypto.timingSafeEqual(got, exp)) ||
           (got.length === altB.length && crypto.timingSafeEqual(got, altB));
  } catch (e) {
    return false;
  }
}

// Build derived feeds from __CROUTONS
function rebuildFeeds() {
  const croutons = global.__CROUTONS || [];

  // Corpora
  const corporaMap = new Map();
  for (let i = 0; i < croutons.length; i++) {
    const c = croutons[i];
    const cid = c.corpus_id || "default";
    if (!corporaMap.has(cid)) corporaMap.set(cid, []);
    corporaMap.get(cid).push(c);
  }
  global.__CORPORA = Array.from(corporaMap.entries()).map(function (entry) {
    return { corpus_id: entry[0], croutons: entry[1] };
  });

  // Simple triples graph from croutons with { triple:{subject,predicate,object} }
  const triples = [];
  let t = 0;
  for (let j = 0; j < croutons.length; j++) {
    const c = croutons[j];
    if (c.triple && c.triple.subject && c.triple.predicate && c.triple.object) {
      triples.push({
        triple_id: "trp_" + (t++),
        subject: c.triple.subject,
        predicate: c.triple.predicate,
        object: c.triple.object,
        evidence: [c.crouton_id || null].filter(Boolean)
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

// ===== Import (NDJSON, HMAC required) =====
app.post("/import", ndjsonBody, function (req, res) {
  const raw = req.body || "";
  if (!raw) return res.status(400).json({ error: "empty body" });

  if (!verifyHmacHeader(req, raw)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  // Split NDJSON
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return res.status(400).json({ error: "no lines" });

  const MAX_LINE_BYTES = 100000; // 100 KB per line (no numeric separators for JSHint)
  const batch = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.length > MAX_LINE_BYTES) {
      return res.status(413).json({ error: "line too large" });
    }

    try {
      const obj = JSON.parse(line);
      batch.push(obj);
    } catch (e) {
      return res.status(400).json({ error: "invalid JSON line: " + line.slice(0, 120) + "..." });
    }
  }

  // TODO: add idempotency/dedupe on source_hash here
  Array.prototype.push.apply(global.__CROUTONS, batch);
  rebuildFeeds();

  return res.json({ accepted: batch.length });
});

// ===== Feeds =====
function setNdjsonHeaders(res) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  // Edge cache 300s; browsers short cache to avoid staleness while developing
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
}

app.get("/feeds/croutons.ndjson", function (_req, res) {
  setNdjsonHeaders(res);
  const rows = (global.__CROUTONS || []).map(function (o) { return JSON.stringify(o); });
  res.send(rows.join("\n") + "\n");
});

app.get("/feeds/corpora.ndjson", function (_req, res) {
  setNdjsonHeaders(res);
  const rows = (global.__CORPORA || []).map(function (o) { return JSON.stringify(o); });
  res.send(rows.join("\n") + "\n");
});

app.get("/feeds/graph.json", function (_req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  res.send(JSON.stringify({
    generated_at: new Date().toISOString(),
    triples: global.__GRAPH || []
  }, null, 2));
});

// ===== Boot =====
app.listen(PORT, function () {
  const fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log("graph-service running on " + PORT + " (secret fp: " + fp + ")");
});