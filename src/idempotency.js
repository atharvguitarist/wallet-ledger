'use strict';

/*
 * Milestone 3 — never charge twice.
 *
 * Every POST runs through idempotent(handler). In ONE transaction we:
 *   1. INSERT the (user, key) row first. The UNIQUE (user_id, idempotency_key)
 *      constraint does the hard part: if an identical request is in flight,
 *      our INSERT waits for it; when it commits we get "already exists".
 *   2. Run the handler (the money path) inside a SAVEPOINT.
 *   3. Save the response (status + exact body text) on the key row.
 *   4. COMMIT. The key and the money become visible together, or not at all.
 *
 * Seen the key before?
 *   same body + completed  -> replay the saved status code and body, byte for byte
 *   different body         -> 422 IDEMPOTENCY_KEY_MISMATCH, nothing runs
 *
 * Business errors (insufficient funds, held, ...) are saved too, so a retry of
 * a failed payment gets the same failure back instead of trying again later.
 * Unexpected errors (bugs, DB down) roll back the key as well, so the client
 * may safely retry.
 */

const crypto = require('crypto');
const { pool, setActor, RETRYABLE, sleep } = require('./db');
const { AppError, errorBody } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON with keys sorted, so {"a":1,"b":2} and {"b":2,"a":1} hash the same. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hashRequest(method, path, body) {
  return crypto.createHash('sha256').update(`${method} ${path}\n${canonicalJson(body ?? {})}`).digest('hex');
}

function actorFor(req) {
  if (req.admin) return `admin:${req.admin}`;
  if (req.callerUserId) return `user:${req.callerUserId}`;
  return 'anonymous';
}

async function runOnce({ req, handler, userId, key, method, path, requestHash }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await setActor(client, actorFor(req));

    // 1. Claim the key. ON CONFLICT DO NOTHING behaves like "insert, and if the
    //    unique constraint fails, give me no row": it also waits for an
    //    in-flight transaction holding the same key to finish first.
    const claimed = await client.query(
      `INSERT INTO idempotency_keys (user_id, idempotency_key, request_method, request_path, request_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ON CONSTRAINT idempotency_keys_user_key_uniq DO NOTHING
       RETURNING id`,
      [userId, key, method, path, requestHash]
    );

    if (claimed.rowCount === 0) {
      // Seen before: roll back our (empty) transaction and look at the first request.
      await client.query('ROLLBACK');
      const { rows } = await client.query(
        `SELECT request_hash, status, response_code, response_body
           FROM idempotency_keys
          WHERE user_id IS NOT DISTINCT FROM $1 AND idempotency_key = $2`,
        [userId, key]
      );
      const first = rows[0];
      if (!first) return { retry: true }; // the other request rolled back between our two statements
      if (first.request_hash !== requestHash) {
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_MISMATCH',
          'This Idempotency-Key was already used with a different request body. Use a new key for a new request.'
        );
      }
      if (first.status !== 'completed') {
        throw new AppError(409, 'REQUEST_IN_PROGRESS', 'The first request with this key is still running. Retry shortly.');
      }
      return { status: first.response_code, bodyText: first.response_body, replayed: true };
    }

    // 2. Run the real work inside a savepoint.
    await client.query('SAVEPOINT money_path');
    let result;
    try {
      result = await handler(client, req);
      await client.query('RELEASE SAVEPOINT money_path');
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      // A business "no": undo the work but keep (and later save) the key.
      await client.query('ROLLBACK TO SAVEPOINT money_path');
      result = { status: err.status, body: errorBody(err.code, err.message, req.requestId) };
    }

    // 3. Save the exact response on the key row.
    const bodyText = JSON.stringify(result.body);
    await client.query(
      `UPDATE idempotency_keys
          SET status = 'completed', response_code = $2, response_body = $3, completed_at = now()
        WHERE id = $1`,
      [claimed.rows[0].id, result.status, bodyText]
    );

    // 4. Money, transfer rows and the saved response all commit together.
    await client.query('COMMIT');
    return { status: result.status, bodyText, replayed: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Express handler factory: idempotent(async (client, req) => ({ status, body })) */
function idempotent(handler) {
  return async (req, res) => {
    const key = req.get('Idempotency-Key');
    if (!key) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Every POST needs an Idempotency-Key header containing a UUID.');
    }
    if (!UUID_RE.test(key)) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be a UUID, e.g. 3f1c9b2e-8a4d-4c1e-9f7a-2b6d5e4c3a10.');
    }
    const path = req.originalUrl.split('?')[0];
    const params = {
      req,
      handler,
      userId: req.callerUserId ?? null,
      key: key.toLowerCase(),
      method: req.method,
      path,
      requestHash: hashRequest(req.method, path, req.body),
    };

    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = await runOnce(params);
        if (outcome.retry && attempt < 5) continue;
        if (outcome.replayed) res.set('Idempotent-Replayed', 'true');
        res.status(outcome.status).type('application/json').send(outcome.bodyText);
        return;
      } catch (err) {
        // Deadlock / serialization failure: nothing was committed, run it again.
        if (RETRYABLE.has(err.code) && attempt < 5) {
          await sleep(10 * attempt + Math.random() * 25);
          continue;
        }
        throw err;
      }
    }
  };
}

module.exports = { idempotent, hashRequest, canonicalJson };
