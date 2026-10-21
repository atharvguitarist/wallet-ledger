'use strict';

const { Pool, types } = require('pg');
const config = require('./config');

// BIGINT (OID 20) comes back from pg as a string by default. Money is BIGINT
// paise; we turn it into a JS number but refuse anything that would lose
// precision (above 2^53 paise ≈ ₹90 lakh crore).
types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`BIGINT ${value} is outside the safe integer range`);
  return n;
});

const pool = new Pool({ connectionString: config.databaseUrl, max: config.pgPoolMax });
pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// 40001 = serialization_failure, 40P01 = deadlock_detected. Both mean
// "nothing was written, try the whole transaction again".
const RETRYABLE = new Set(['40001', '40P01']);
const ISOLATION = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run fn(client) inside one transaction. Commits if fn resolves, rolls back
 * if it throws. Retries the whole thing on serialization failure / deadlock.
 */
async function withTransaction(fn, { isolation = 'READ COMMITTED', actor = 'system', reason = '', retries = 3 } = {}) {
  if (!ISOLATION.has(isolation)) throw new Error(`unknown isolation level ${isolation}`);
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await setActor(client, actor, reason);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (RETRYABLE.has(err.code) && attempt < retries) {
        await sleep(10 * attempt + Math.random() * 20);
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Tells the audit trigger who is making this change (transaction-local). */
function setActor(client, actor, reason = '') {
  return client.query("SELECT set_config('app.actor', $1, true), set_config('app.reason', $2, true)", [
    String(actor),
    String(reason || ''),
  ]);
}

module.exports = { pool, withTransaction, setActor, RETRYABLE, sleep };
