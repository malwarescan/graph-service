/* jshint node:true, esversion:11 */

// graph-service — Truth Hose (DB + auto-hash)
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 8080;
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function hmacHex(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}
function verifyHmacHeader(req, body) {
  const header = req.get("X-Signature") || "";
  if (!header.startsWith("sha256=")) return false;
  const got = header.slice(7);
  const exact = hmacHex(body);
  const alt = body.endsWith("\n") ? hmacHex(body.slice(0, -1))
    : hmacHex(body + "\n");
  try {
    const g = Buffer.from(got, "hex");
    const e = Buffer.from(exact, "hex");
    const a = Buffer.from(alt, "hex");
    return (
      (g.length === e.length && crypto.timingSafeEqual(g, e)) ||
      (g.length === a.length && crypto.timingSafeEqual(g, a))
    );
  } catch {
    return false;
  }
}
function sha256hex(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}
async function queryRows(sql, params = []) {
  const c = await pool.connect();
  try {
    const r = await c.query(sql, params);
    return r.rows;
  } finally {
    c.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.disable("x-powered-by");
const ndjsonBody = express.text({ type: "*/*", limit: "5mb" });

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.send("ok"));

// ─────────────────────────────────────────────────────────────────────────────
// Import (NDJSON + HMAC)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/import", ndjsonBody, async (req, res) => {
  const raw = req.body || "";
  if (!raw) return res.status(400).json({ error: "empty body" });
  if (!verifyHmacHeader(req, raw))
    return res.status(401).json({ error: "invalid signature" });

  const lines = raw.split("\n").filter(Boolean);
  const batch = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      // compute hashes if missing
      o.source_hash = o.source_hash || sha256hex(o.source_url || "");
      o.context_hash =
        o.context_hash ||
        sha256hex((o.text || "") + (o.verified_at || ""));
      batch.push(o);
    } catch {
      return res.status(400).json({ error: `invalid JSON line: ${l}` });
    }
  }

  const client = await pool.connect();
  let accepted = 0,
    skipped = 0;
  try {
    for (const c of batch) {
      const q = `
        INSERT INTO croutons
          (crouton_id, source_url, source_hash, corpus_id,
           triple, text, confidence, verified_at,
           context_hash, contextually_verified, verification_meta)
        VALUES
          ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (source_hash) DO NOTHING
        RETURNING id;
      `;
      const v = [
        c.crouton_id || null,
        c.source_url || null,
        c.source_hash || null,
        c.corpus_id || null,
        c.triple ? JSON.stringify(c.triple) : null,
        c.text || null,
        c.confidence || null,
        c.verified_at || null,
        c.context_hash || null,
        c.contextually_verified || null,
        c.verification_meta ? JSON.stringify(c.verification_meta) : null,
      ];
      const r = await client.query(q, v);
      if (r.rowCount > 0) accepted++;
      else skipped++;
    }
    res.json({ accepted, skipped, total: batch.length });
  } catch (err) {
    console.error("Import failed:", err);
    res.status(500).json({ error: "import_failed", detail: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Feeds
// ─────────────────────────────────────────────────────────────────────────────
async function streamQuery(res, sql, params = []) {
  const rows = await queryRows(sql, params);
  for (const r of rows) res.write(JSON.stringify(r) + "\n");
  res.end();
}

app.get("/feeds/croutons.ndjson", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    req.query.nocache === "1" ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60"
  );
  await streamQuery(res, "SELECT * FROM croutons ORDER BY created_at ASC;");
});

app.get("/feeds/corpora.ndjson", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    req.query.nocache === "1" ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60"
  );
  await streamQuery(
    res,
    "SELECT corpus_id, json_agg(croutons) AS croutons FROM croutons GROUP BY corpus_id;"
  );
});

app.get("/feeds/graph.json", async (req, res) => {
  const rows = await queryRows("SELECT * FROM triples ORDER BY created_at ASC;");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    req.query.nocache === "1" ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60"
  );
  res.json({ generated_at: new Date().toISOString(), triples: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────
app.get("/diag/stats", async (_req, res) => {
  try {
    const [c, t] = await Promise.all([
      queryRows("SELECT count(*)::int AS n FROM croutons;"),
      queryRows("SELECT count(*)::int AS n FROM triples;"),
    ]);
    res.json({
      ok: true,
      counts: { croutons: c[0].n, triples: t[0].n },
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const fp = sha256hex(HMAC_SECRET).slice(0, 16);
  console.log(`graph-service running on ${PORT} (secret fp: ${fp})`);
});