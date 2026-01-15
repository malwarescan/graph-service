/* jshint node: true, esversion: 11 */

const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

(async () => {
  console.log("[migrate] running migrations...");

  const client = await pool.connect();
  try {
  // Ensure migrations table exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id serial PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const appliedRes = await client.query(`SELECT filename FROM schema_migrations;`);
  const already = new Set(appliedRes.rows.map(r => r.filename));

  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  let appliedCount = 0;
  for (const fname of files) {
    if (already.has(fname)) continue;

    const full = path.join(migrationsDir, fname);
    const sql  = fs.readFileSync(full, "utf8");

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename) VALUES ($1);`,
        [fname]
      );
      await client.query("COMMIT");
      console.log(`✅ Applied ${fname}`);
      appliedCount++;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`❌ Failed ${fname}:`, e.message);
      throw e;
    }
  }

  console.log(appliedCount > 0 ? `Migrations applied: ${appliedCount}` : "No new migrations.");
  } finally {
    client.release();
    await pool.end();
}
})().catch(err => {
  console.error(err);
  process.exit(1);
});