app.post("/import", ndjsonBody, async function (req, res) {
  const raw = req.body || "";
  if (!raw) return res.status(400).json({ error: "empty body" });

  if (!verifyHmacHeader(req, raw)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return res.status(400).json({ error: "no lines" });

  const MAX_LINE_BYTES = 100000; // 100 KB per line
  const batch = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE_BYTES) return res.status(413).json({ error: "line too large" });

    try {
      const obj = JSON.parse(line);
      batch.push(obj);
    } catch {
      return res.status(400).json({ error: "invalid JSON line: " + line.slice(0, 120) + "..." });
    }
  }

  // Insert into Postgres
  const insertQuery = `
    INSERT INTO croutons (crouton_id, source_url, source_hash, corpus_id, triple, text, confidence, verified_at, context_hash, contextually_verified, verification_meta)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (crouton_id) DO NOTHING;
  `;

  const db = require("./db");

  for (const c of batch) {
    const vals = [
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
      c.verification_meta ? JSON.stringify(c.verification_meta) : null,
    ];
    try {
      await db.query(insertQuery, vals);
    } catch (e) {
      console.error("DB insert error:", e.message);
    }
  }

  Array.prototype.push.apply(global.__CROUTONS, batch);
  rebuildFeeds();
  return res.json({ accepted: batch.length });
});