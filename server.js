// server.js (CommonJS) — Truth Hose + diagnostics
const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

// ===== Config =====
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";

// ===== Stores (replace with DB later) =====
global.__CROUTONS = global.__CROUTONS || [];
global.__CORPORA  = global.__CORPORA  || [];
global.__GRAPH    = global.__GRAPH    || [];

// ===== Helpers =====
function verifyHmac(req, bodyStr) {
  const sigHeader = req.get("X-Signature") || req.get("x-signature") || "";
  if (!sigHeader.startsWith("sha256=")) return false;
  const got = sigHeader.slice("sha256=".length);
  const calc = crypto.createHmac("sha256", HMAC_SECRET).update(bodyStr).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(calc, "hex"));
  } catch {
    return false;
  }
}

function calcSigHex(bodyStr) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(bodyStr).digest("hex");
}

function verifyFlexibleHmac(req, body) {
  // Accept exact body and newline variants
  return (
    verifyHmac(req, body) ||
    verifyHmac(req, body.endsWith("\n") ? body.slice(0, -1) : body + "\n")
  );
}

function rebuildFeedsFromMemory() {
  const croutons = global.__CROUTONS || [];
  const corporaMap = new Map();
  for (const c of croutons) {
    const cid = c.corpus_id || "default";
    if (!corporaMap.has(cid)) corporaMap.set(cid, []);
    corporaMap.get(cid).push(c);
  }
  global.__CORPORA = Array.from(corporaMap.entries()).map(([corpus_id, list]) => ({
    corpus_id, croutons: list
  }));

  const triples = [];
  let i = 0;
  for (const c of croutons) {
    if (c.triple && c.triple.subject && c.triple.predicate && c.triple.object) {
      triples.push({
        triple_id: `trp_${i++}`,
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
const rawText = express.text({ type: "*/*", limit: "20mb" });

// ===== Health =====
app.get("/healthz", (req, res) => res.send("ok"));

// ===== IMPORT (NDJSON, HMAC required) =====
app.post("/import", rawText, (req, res) => {
  try {
    const bodyRaw = req.body || "";
    if (bodyRaw.length === 0) return res.status(400).json({ error: "empty body" });

    const ok = verifyFlexibleHmac(req, bodyRaw);
    if (!ok) return res.status(401).json({ error: "invalid signature" });

    const lines = bodyRaw.split("\n").filter(Boolean);
    const parsed = [];
    for (const l of lines) {
      try { parsed.push(JSON.parse(l)); }
      catch { return res.status(400).json({ error: `invalid JSON line: ${l.slice(0,120)}...` }); }
    }
    global.__CROUTONS.push(...parsed);
    rebuildFeedsFromMemory();
    return res.json({ accepted: parsed.length });
  } catch (err) {
    console.error("Import error:", err);
    return res.status(500).json({ error: "import_failed" });
  }
});

// ===== Feeds =====
app.get("/feeds/croutons.ndjson", (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  const rows = (global.__CROUTONS || []).map(o => JSON.stringify(o));
  res.send(rows.join("\n") + "\n");
});

app.get("/feeds/corpora.ndjson", (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  const rows = (global.__CORPORA || []).map(o => JSON.stringify(o));
  res.send(rows.join("\n") + "\n");
});

app.get("/feeds/graph.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  res.send(JSON.stringify({
    generated_at: new Date().toISOString(),
    triples: global.__GRAPH || []
  }, null, 2));
});

// ===== DIAGNOSTICS (TEMPORARY; remove after debugging) =====

// Shows short hash of the loaded secret + a reference signature for "PROBE\n"
app.get("/diag/ping", (req, res) => {
  const secretHash = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  const probePayload = "PROBE\n";
  const probeSig = calcSigHex(probePayload);
  res.json({
    ok: true,
    secret_fingerprint: secretHash,     // not the secret; safe to reveal
    probe_payload: Buffer.from(probePayload).toString("base64"), // "UFJPQkUK"
    server_signature_hex: probeSig,     // hex only
    server_signature_header: `sha256=${probeSig}`
  });
});

// Echoes what you sent vs what the server computes, for the exact body
app.post("/diag/echo", rawText, (req, res) => {
  const body = req.body || "";
  const recv = req.get("X-Signature") || "";
  const calc = `sha256=${calcSigHex(body)}`;
  res.json({
    bytes: body.length,
    received_signature: recv,
    server_signature: calc,
    matches: recv === calc
  });
});

// ===== Boot =====
app.listen(PORT, () => {
  const fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log(`graph-service running on ${PORT} (secret fp: ${fp})`);
});