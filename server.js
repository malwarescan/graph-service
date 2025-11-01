/* jshint node: true, esversion: 11 */
"use strict";

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8080;
const HMAC_SECRET = process.env.PUBLISH_HMAC_KEY || "dev-secret";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) console.warn("[warn] DATABASE_URL not set.");

const pool = new Pool({ connectionString: DATABASE_URL });
const app = express();
app.disable("x-powered-by");
const ndjsonBody = express.text({ type: "*/*", limit: "5mb" });

function hmacHex(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}
function verifyHmac(req, body) {
  const header = req.get("X-Signature") || "";
  if (!header.startsWith("sha256=")) return false;
  const got = header.slice(7);
  const exact = hmacHex(body);
  const alt = body.endsWith("\n") ? hmacHex(body.slice(0, -1)) : hmacHex(body + "\n");
  try {
    const b1 = Buffer.from(got, "hex");
    const b2 = Buffer.from(exact, "hex");
    const b3 = Buffer.from(alt, "hex");
    return (
      (b1.length === b2.length && crypto.timingSafeEqual(b1, b2)) ||
      (b1.length === b3.length && crypto.timingSafeEqual(b1, b3))
    );
  } catch {
    return false;
  }
}

function setJSON(res, body, noCache) {
  const etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    noCache ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60"
  );
  return etag;
}

function setNDJSON(res, body, noCache) {
  const etag = crypto.createHash("sha256").update(body).digest("hex");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    noCache ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=300, stale-while-revalidate=60"
  );
  return etag;
}

app.get("/healthz", (_req, res) => res.send("ok"));

app.post("/import", ndjsonBody, async (req, res) => {
  const raw = req.body || "";
  if (!raw) return res.status(400).json({ error: "empty body" });
  if (!verifyHmac(req, raw)) return res.status(401).json({ error: "invalid signature" });

  const lines = raw.split("\n").filter(Boolean);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let accepted = 0,
      skipped = 0;

    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "invalid JSON line" });
      }

      const src = obj.source_url;
      if (!src) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "missing source_url" });
      }

      const hash = crypto.createHash("sha256").update(src).digest("hex");
      const ins = `
        INSERT INTO croutons
          (crouton_id, source_url, source_hash, corpus_id, triple, text, confidence,
           verified_at, context_hash, contextually_verified, verification_meta)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (source_hash) DO NOTHING RETURNING id
      `;
      const vals = [
        obj.crouton_id || null,
        src,
        hash,
        obj.corpus_id || null,
        obj.triple ? JSON.stringify(obj.triple) : null,
        obj.text || null,
        obj.confidence ?? null,
        obj.verified_at ? new Date(obj.verified_at) : null,
        obj.context_hash || null,
        obj.contextually_verified ?? null,
        obj.verification_meta ? JSON.stringify(obj.verification_meta) : null,
      ];
      const r = await client.query(ins, vals);
      if (r.rowCount === 1) accepted++;
      else skipped++;

      // auto-insert triple if present
      if (obj.triple && obj.triple.subject && obj.triple.predicate && obj.triple.object) {
        const tIns = `
          INSERT INTO triples (subject,predicate,object,evidence_crouton_id)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (subject,predicate,object) DO NOTHING
        `;
        await client.query(tIns, [
          obj.triple.subject,
          obj.triple.predicate,
          obj.triple.object,
          obj.crouton_id || null,
        ]);
      }
    }

    await client.query("COMMIT");
    res.json({ accepted, skipped, total: accepted + skipped });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("import_failed:", e);
    res.status(500).json({ error: "import_failed" });
  } finally {
    client.release();
  }
});

app.get("/feeds/croutons.ndjson", async (req, res) => {
  const noCache = req.query.nocache === "1";
  const q = `
    SELECT crouton_id, source_url, source_hash, corpus_id, triple, text,
           confidence, verified_at, context_hash, contextually_verified, verification_meta
    FROM croutons ORDER BY created_at ASC
  `;
  const r = await pool.query(q);
  const body = r.rows.map((o) => JSON.stringify(o)).join("\n") + "\n";
  setNDJSON(res, body, noCache);
  res.send(body);
});

app.get("/feeds/graph.json", async (req, res) => {
  const noCache = req.query.nocache === "1";
  const q = `
    SELECT subject, predicate, object, evidence_crouton_id, created_at
    FROM triples ORDER BY created_at ASC
  `;
  const r = await pool.query(q);
  const body = JSON.stringify(
    { generated_at: new Date().toISOString(), triples: r.rows },
    null,
    2
  );
  setJSON(res, body, noCache);
  res.send(body);
});

app.get("/diag/stats", async (_req, res) => {
  const c1 = await pool.query("SELECT COUNT(*)::int AS n FROM croutons");
  const c2 = await pool.query("SELECT COUNT(*)::int AS n FROM triples");
  res.json({
    ok: true,
    counts: { croutons: c1.rows[0].n, triples: c2.rows[0].n },
    time: new Date().toISOString(),
  });
});

app.get("/diag/schema", async (_req, res) => {
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' ORDER BY table_name
  `);
  const columns = await pool.query(`
    SELECT table_name,column_name,data_type
    FROM information_schema.columns
    WHERE table_schema='public' ORDER BY table_name,ordinal_position
  `);
  res.json({ tables: tables.rows, columns: columns.rows });
});

app.listen(PORT, () => {
  const fp = crypto.createHash("sha256").update(HMAC_SECRET).digest("hex").slice(0, 16);
  console.log(`graph-service running on ${PORT} (secret fp: ${fp})`);
});