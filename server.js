/* jshint node: true, esversion: 11 */
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { URL: NodeURL } = require("url");

const app = express();
const PORT = process.env.PORT || 8080;

// ===== Config =====
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";
const dbUrl = new NodeURL(process.env.DATABASE_URL || "");
const useInternal = dbUrl.hostname.endsWith("railway.internal");
const sslSetting = useInternal ? false : { rejectUnauthorized: false };

console.log(`[db] using: ${dbUrl.hostname}:${dbUrl.port || 5432} ssl: ${sslSetting ? "true(no-verify)" : "false"}`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslSetting,
});

// ===== Helpers =====
function hmacHex(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}

function verifyHmacHeader(req, body) {
  const header = req.get("X-Signature") || req.get("x-signature") || "";
  if (!header.startsWith("sha256=")) return false;
  const gotHex = header.slice("sha256=".length);
  const exact = hmacHex(body);
  const alt = body.endsWith("\n") ? hmacHex(body.slice(0, -1)) : hmacHex(body + "\n");
  try {
    const got = Buffer.from(gotHex, "hex");
    const exp = Buffer.from(exact, "hex");
    const altB = Buffer.from(alt, "hex");
    return (
      (got.length === exp.length && crypto.timingSafeEqual(got, exp)) ||
      (got.length === altB.length && crypto.timingSafeEqual(got, altB))
    );
  } catch {
    return false;
  }
}

function ndjsonFromRows(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function setNdjsonHeaders(res, noCache, body) {
  const etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    noCache
      ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60"
  );
  return etag;
}

const ndjsonBody = express.text({ type: "*/*", limit: "5mb" });
app.disable("x-powered-by");

// ===== Health =====
app.get("/healthz", (_req, res) => res.send("ok"));

// ===== DB Diagnostics =====
app.get("/diag/db", async (_req, res) => {
  try {
    const r = await pool.query("SELECT now(), current_database()");
    res.json({ ok: true, result: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Stats =====
app.get("/diag/stats", async (_req, res) => {
  try {
    const cr = await pool.query("SELECT COUNT(*)::int AS n FROM croutons");
    const tr = await pool.query("SELECT COUNT(*)::int AS n FROM triples");
    res.json({
      ok: true,
      counts: { croutons: cr.rows[0].n, triples: tr.rows[0].n },
      time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== Feeds =====
app.get("/feeds/croutons.ndjson", async (req, res) => {
  const noCache = String(req.query.nocache || "") === "1";
  const { rows } = await pool.query(
    `SELECT id::text, crouton_id, source_url, source_hash, corpus_id, triple, text,
            confidence, verified_at, created_at, context_hash, contextually_verified, verification_meta
     FROM croutons ORDER BY created_at ASC`
  );
  const body = ndjsonFromRows(rows);
  const etag = setNdjsonHeaders(res, noCache, body);
  if (req.headers["if-none-match"] === etag && !noCache) return res.status(304).end();
  res.send(body);
});

app.get("/feeds/graph.json", async (req, res) => {
  const noCache = String(req.query.nocache || "") === "1";
  const { rows } = await pool.query(
    `SELECT subject, predicate, object, evidence_crouton_id, created_at FROM triples ORDER BY created_at ASC`
  );
  const payload = { generated_at: new Date().toISOString(), triples: rows };
  const body = JSON.stringify(payload, null, 2);
  const etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    noCache
      ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60"
  );
  if (req.headers["if-none-match"] === etag && !noCache) return res.status(304).end();
  res.send(body);
});

// ===== Static Files =====
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    setHeaders(res, filePath) {
      res.setHeader(
        "Cache-Control",
        filePath.endsWith(".html")
          ? "no-store, no-cache, must-revalidate, max-age=0"
          : "public, max-age=300, stale-while-revalidate=60"
      );
    },
  })
);

// ===== Admin Pages =====
app.get("/dashboard", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "dashboard.html"))
);
app.get("/docs", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "docs.html"))
);
app.get("/", (_req, res) => res.redirect("/dashboard"));

// ===== Boot =====
app.listen(PORT, () => {
  const fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log(`graph-service running on ${PORT} (secret fp: ${fp})`);
});

module.exports = app;
