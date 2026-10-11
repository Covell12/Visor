// Database connection.
//
// Used when Visor runs on your own computer (on Firebase, lib/repoFirestore.js
// is used instead). With no DATABASE_URL an embedded Postgres (PGlite) keeps
// everything in data/pglite; set DATABASE_URL to use any other Postgres.
//
// Exposes two things:
//   query(sql, params)  -> rows
//   tx(async q => ...)  -> runs q(sql, params) calls inside one transaction

const path = require('path');
const fs = require('fs');

let impl = null;

function makePg() {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 5000,
    // Hosted Postgres usually requires TLS. Local Postgres usually doesn't.
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }
  });
  return {
    kind: 'postgres',
    async query(sql, params) { return (await pool.query(sql, params)).rows; },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(async (sql, params) => (await client.query(sql, params)).rows);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      } finally {
        client.release();
      }
    }
  };
}

function makePglite() {
  const { PGlite } = require('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pglite');
  if (dir !== 'memory://') fs.mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  // PGlite is single-connection, so transactions are queued one at a time.
  let chain = Promise.resolve();
  return {
    kind: 'pglite',
    async query(sql, params) { await chain; return (await db.query(sql, params)).rows; },
    tx(fn) {
      const run = chain.then(() => db.transaction(async t => fn(async (sql, params) => (await t.query(sql, params)).rows)));
      chain = run.catch(() => {});
      return run;
    }
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS visor_core (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS visor_resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS visor_resources_project ON visor_resources (project_id);
CREATE TABLE IF NOT EXISTS visor_analyses (
  project_id TEXT PRIMARY KEY,
  data JSONB NOT NULL
);
`;

let ready = null;
function db() {
  if (!impl) impl = process.env.DATABASE_URL ? makePg() : makePglite();
  if (!ready) {
    ready = (async () => {
      for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) await impl.query(stmt);
      await impl.query(`INSERT INTO visor_core (id, data) VALUES (1, '{"orgs":{},"users":{},"projects":{}}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    })().catch(err => { ready = null; throw err; });
  }
  return ready.then(() => impl);
}

module.exports = { db };
