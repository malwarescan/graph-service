// server.js (CommonJS)
// Full Truth Hose origin service with import + feeds
// Fixed: HMAC verification handles trailing newline and passes JSHint cleanly

const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

// ====== Config ======
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";

// ====== In-memory stores (replace with Postgres later) ======
global.__CROUTONS = global.__CROUTONS || [];   // array of crouton objects
global.__CORPORA  = global.__CORPORA  || [];   // [{ corpus_id, croutons: [...] }]
global.__GRAPH    = global.__GRAPH    || [];   // [{ triple_id, subject, predicate, object, evidence: [crouton_id] }]

// ====== Helpers ======
function verifyHmac(req, bodyStr) {
  const sigHeader = req.get("X-Signature") || "";
  if (!sigHeader.startsWith("sha256=")) return false;
  const got = sigHeader.slice("sha256=".length);
  const calc = crypto.createHmac("sha256", HMAC_SECRET).update(bodyStr).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(calc));
  } catch {
    return false;
  }
}

function verifyFlexibleHmac(req, body) {
  // Try both exact body and its newline variants
  return (
    verifyHmac(req, body) ||
    verifyHmac(req, body.endsWith("\n") ? body.slice(0, -1) : body + "\n")
  );
}

function rebuildFeedsFromMemory() {
  const croutons = global.__CROUTONS || [];

  // Build corpora by "corpus_id" if present, otherwise bucket as "default"
  const corporaMap = new Map();
  for (const c of croutons) {
    const cid = c.corpus_id || "default";
    if (!corporaMap.has(cid)) corporaMap.set(cid, []);
    corporaMap.get(cid).push(c);
  }
  global.__CORPORA = Array.from(corporaMap.entries()).map(([corpus_id, list]) => ({
    corpus_id,
    croutons: list
  }));

  // Build simple graph view from croutons that have a "triple" field
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

// ====== Middleware ======
const rawText = express.text({ type: "*/*", limit: "20mb" });

// ====== Routes ======
app.get("/healthz", (req, res) => res.send("ok"));

// Import NDJSON from Croutonizer (HMAC required)
app.post("/import", rawText, (req, res) => {
  try {
    const bodyRaw = req.body || "";
    if (bodyRaw.length === 0) {
      return res.status(400).json({ error: "empty body" });
    }

    // ✅ Secure + lint-safe HMAC verification
    const ok = verifyFlexibleHmac(req, bodyRaw);
    if (!ok) {
      return res.status(401).json({ error: "invalid signature" });
    }

    const lines = bodyRaw.split("\n").filter(Boolean);
    const parsed = [];
    for (const l of lines) {
      try {
        parsed.push(JSON.parse(l));
      } catch (e) {
        return res.status(400).json({ error: `invalid JSON line: ${l.slice(0, 120)}...` });
      }
    }

    // Append to in-memory store
    global.__CROUTONS.push(...parsed);

    // Rebuild derivative feeds
    rebuildFeedsFromMemory();

    return res.json({ accepted: parsed.length });
  } catch (err) {
    console.error("Import error:", err);
    return res.status(500).json({ error: "import_failed" });
  }
});

// Atomic facts feed (NDJSON)
app.get("/feeds/croutons.ndjson", (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  const rows = (global.__CROUTONS || []).map(obj => JSON.stringify(obj));
  res.send(rows.join("\n") + "\n");
});

// Grouped corpora feed (NDJSON)
app.get("/feeds/corpora.ndjson", (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  const rows = (global.__CORPORA || []).map(obj => JSON.stringify(obj));
  res.send(rows.join("\n") + "\n");
});

// Knowledge graph snapshot (JSON)
app.get("/feeds/graph.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  const payload = {
    generated_at: new Date().toISOString(),
    triples: global.__GRAPH || []
  };
  res.send(JSON.stringify(payload, null, 2));
});

// ====== Boot ======
app.listen(PORT, () => {
  console.log(`graph-service running on ${PORT}`);
});