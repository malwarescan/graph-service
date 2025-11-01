/* jshint node: true, esversion: 11 */

const fs   = require("fs");
const path = require("path");
const { Client } = require("pg");

async function run() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
  }

  // Railway internal Postgres typically does not require SSL in-container.
  // If you ever switch to a public connection string that requires SSL,
  // flip ssl: { rejectUnauthorized: false } on.
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: false
  });

  await client.connect();

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
    .sort(); // lexicographic order

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
      console.log(`Applied ${fname}`);
      appliedCount++;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`Failed ${fname}:`, e.message);
      throw e;
    }
  }

  await client.end();
  console.log(appliedCount > 0 ? `Migrations applied: ${appliedCount}` : "No new migrations.");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});