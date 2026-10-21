'use strict';

// Applies migrations/*.sql in filename order, each in its own transaction,
// and records them in schema_migrations. Safe to run from several processes
// at once (API and worker both call it at start-up) thanks to an advisory lock.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const ADVISORY_LOCK_ID = 727274;

async function connectWithRetry(databaseUrl, attempts = 30) {
  for (let i = 1; ; i += 1) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function migrate(databaseUrl, { log = console.log } = {}) {
  const client = await connectWithRetry(databaseUrl);
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        filename    TEXT        NOT NULL UNIQUE,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
    log('[migrate] schema is up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {});
    await client.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const config = require('../src/config');
  migrate(config.databaseUrl).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
