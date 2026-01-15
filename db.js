require("dotenv").config();

const { URL: NodeURL } = require("url");
const { Pool, Client } = require("pg");

// Pick the right connection string depending on environment
let rawUrl = process.env.DATABASE_URL_LOCAL; // default to local proxy
const inRailway = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_ENVIRONMENT;

if (inRailway && process.env.DATABASE_URL) {
  rawUrl = process.env.DATABASE_URL; // use internal one in Railway container
}

if (!rawUrl) {
  console.error("[db] ❌ No DATABASE_URL or DATABASE_URL_LOCAL set!");
  process.exit(1);
}

const dbUrl = new NodeURL(rawUrl);
const isInternal = /\.railway\.internal$/.test(dbUrl.hostname);
const sslOption = isInternal ? false : { rejectUnauthorized: false };

console.log(
  `[db] using: ${dbUrl.hostname}:${dbUrl.port || "(default)"} ssl: ${
    sslOption ? "true(no-verify)" : "false"
  }`
);

const pool = new Pool({
  connectionString: dbUrl.toString(),
  ssl: sslOption,
});

module.exports = { pool, Client, sslOption, dbUrl };
