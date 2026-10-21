'use strict';

// Milestone 1: "let the database protect you". These go straight to SQL,
// bypassing the application, to prove the constraints hold on their own.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, startServer, client, createUser, topUp, scalar } = require('./helpers');

let server;
let api;
let a;
let b;
let transferId;

before(async () => {
  await resetDatabase();
  server = await startServer();
  api = client(server.baseUrl);
  a = await createUser(api, 'Guard A');
  b = await createUser(api, 'Guard B');
  await topUp(api, a.user.id, a.wallet.id, 10000);
  const t = await api('POST', '/transfers', { userId: a.user.id, body: { from_wallet_id: a.wallet.id, to_wallet_id: b.wallet.id, amount: 4000 } });
  transferId = t.body.transfer.id;
});

after(async () => {
  await server.close();
  await pool.end();
});

test('ledger entries cannot be updated or deleted', async () => {
  await assert.rejects(pool.query('UPDATE ledger_entries SET amount = 1 WHERE transfer_id = $1', [transferId]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM ledger_entries WHERE transfer_id = $1', [transferId]), /append-only/);
  await assert.rejects(pool.query('TRUNCATE ledger_entries CASCADE'), /append-only/);
});

test('an unbalanced transfer cannot commit', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [t] } = await db.query(
      `INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id)
       VALUES ('p2p', 'completed', 500, $1, $2) RETURNING id`,
      [a.wallet.id, b.wallet.id]
    );
    await db.query(`INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ($1, $2, 'debit', 500)`, [t.id, a.wallet.id]);
    await assert.rejects(db.query('COMMIT'), /unbalanced/); // the deferred trigger fires at COMMIT
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    db.release();
  }
});

test('a user wallet balance can never go below zero; a system account can', async () => {
  await assert.rejects(pool.query('UPDATE accounts SET balance = -1 WHERE id = $1', [a.wallet.id]), /accounts_wallet_non_negative/);
  assert.ok((await scalar(`SELECT balance FROM accounts WHERE system_code = 'cash_in'`)) < 0);
});

test('amounts must be positive; direction is a separate column', async () => {
  await assert.rejects(
    pool.query(`INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ($1, $2, 'debit', -5)`, [transferId, a.wallet.id]),
    /ledger_entries_amount_check/
  );
  await assert.rejects(
    pool.query(`INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ($1, $2, 'sideways', 5)`, [transferId, a.wallet.id]),
    /ledger_entries_direction_check/
  );
});

test('transfers are immutable apart from legal status changes', async () => {
  await assert.rejects(pool.query('UPDATE transfers SET amount = 1 WHERE id = $1', [transferId]), /only the status/);
  await assert.rejects(pool.query(`UPDATE transfers SET status = 'held' WHERE id = $1`, [transferId]), /illegal status change/);
  await assert.rejects(pool.query('DELETE FROM transfers WHERE id = $1', [transferId]), /cannot be deleted/);
});

test('idempotency keys are unique per user, including anonymous (NULL) callers', async () => {
  const key = '6f1c9b2e-8a4d-4c1e-9f7a-2b6d5e4c3a10';
  const insert = (userId) => pool.query(
    `INSERT INTO idempotency_keys (user_id, idempotency_key, request_method, request_path, request_hash)
     VALUES ($1, $2, 'POST', '/x', repeat('a', 64))`, [userId, key]);
  await insert(a.user.id);
  await assert.rejects(insert(a.user.id), /idempotency_keys_user_key_uniq/);
  await insert(b.user.id); // a different user may reuse it
  await insert(null);
  await assert.rejects(insert(null), /idempotency_keys_user_key_uniq/);
});

test('a reversal must point at the transfer it undoes', async () => {
  await assert.rejects(
    pool.query(`INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id) VALUES ('reversal', 'completed', 1, $1, $2)`, [a.wallet.id, b.wallet.id]),
    /transfers_related_required/
  );
});
