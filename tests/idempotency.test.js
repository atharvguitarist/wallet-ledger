'use strict';

// Milestone 3 acceptance tests — never charge twice.

const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, startServer, client, createUser, topUp, scalar } = require('./helpers');

let server;
let api;

before(async () => {
  await resetDatabase();
  server = await startServer();
  api = client(server.baseUrl);
});

after(async () => {
  await server.close();
  await pool.end();
});

async function pair() {
  const a = await createUser(api, 'Asha');
  const b = await createUser(api, 'Rahul');
  await topUp(api, a.user.id, a.wallet.id, 100000);
  return { a, b };
}

const transfersFrom = (walletId) => scalar('SELECT count(*)::int FROM transfers WHERE source_account_id = $1', [walletId]);

test('same request sent 5 times in a row -> 1 transfer, 5 identical responses', async () => {
  const { a, b } = await pair();
  const key = crypto.randomUUID();
  const body = { from_wallet_id: a.wallet.id, to_wallet_id: b.wallet.id, amount: 5000, note: 'chai' };

  const responses = [];
  for (let i = 0; i < 5; i += 1) responses.push(await api('POST', '/transfers', { userId: a.user.id, key, body }));

  assert.equal(await transfersFrom(a.wallet.id), 1);
  for (const r of responses) {
    assert.equal(r.status, 201);
    assert.equal(r.text, responses[0].text, 'byte-for-byte identical body');
  }
  assert.equal(responses[0].headers.get('idempotent-replayed'), null);
  assert.equal(responses[4].headers.get('idempotent-replayed'), 'true');
  assert.equal(await scalar('SELECT balance FROM accounts WHERE id = $1', [a.wallet.id]), 95000);
});

test('same key sent 10 times in parallel -> exactly 1 transfer', async () => {
  const { a, b } = await pair();
  const key = crypto.randomUUID();
  const body = { from_wallet_id: a.wallet.id, to_wallet_id: b.wallet.id, amount: 7000 };

  const responses = await Promise.all(
    Array.from({ length: 10 }, () => api('POST', '/transfers', { userId: a.user.id, key, body }))
  );

  assert.equal(await transfersFrom(a.wallet.id), 1);
  for (const r of responses) {
    assert.equal(r.status, 201);
    assert.equal(r.text, responses[0].text);
  }
  assert.equal(await scalar('SELECT balance FROM accounts WHERE id = $1', [a.wallet.id]), 93000);
});

test('same key with a different amount -> 422 and no money moves', async () => {
  const { a, b } = await pair();
  const key = crypto.randomUUID();
  const first = await api('POST', '/transfers', {
    userId: a.user.id, key, body: { from_wallet_id: a.wallet.id, to_wallet_id: b.wallet.id, amount: 1000 },
  });
  assert.equal(first.status, 201);

  const second = await api('POST', '/transfers', {
    userId: a.user.id, key, body: { from_wallet_id: a.wallet.id, to_wallet_id: b.wallet.id, amount: 2000 },
  });
  assert.equal(second.status, 422);
  assert.equal(second.body.code, 'IDEMPOTENCY_KEY_MISMATCH');
  assert.deepEqual(Object.keys(second.body).sort(), ['code', 'message', 'request_id']);
  assert.equal(await transfersFrom(a.wallet.id), 1);
  assert.equal(await scalar('SELECT balance FROM accounts WHERE id = $1', [a.wallet.id]), 99000);
});

test('missing or malformed Idempotency-Key -> 400', async () => {
  const { a, b } = await pair();
  const body = { from_wallet_id: a.wallet.id, to_wallet_id: b.wallet.id, amount: 1000 };
  const missing = await api('POST', '/transfers', { userId: a.user.id, key: null, body });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const bad = await api('POST', '/transfers', { userId: a.user.id, key: 'not-a-uuid', body });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'IDEMPOTENCY_KEY_INVALID');
  assert.equal(await transfersFrom(a.wallet.id), 0);
});

test('a failed payment is replayed as the same failure, even after the wallet is topped up', async () => {
  const { a, b } = await pair();
  const key = crypto.randomUUID();
  const body = { from_wallet_id: a.wallet.id, to_wallet_id: b.wallet.id, amount: 500000 }; // ₹5,000 > ₹1,000
  const first = await api('POST', '/transfers', { userId: a.user.id, key, body });
  assert.equal(first.status, 422);
  assert.equal(first.body.code, 'INSUFFICIENT_FUNDS');

  await topUp(api, a.user.id, a.wallet.id, 1000000);
  const retry = await api('POST', '/transfers', { userId: a.user.id, key, body });
  assert.equal(retry.status, 422);
  assert.equal(retry.text, first.text);
  assert.equal(await transfersFrom(a.wallet.id), 0);
});

test('keys are per user: two users may use the same key independently', async () => {
  const { a, b } = await pair();
  await topUp(api, b.user.id, b.wallet.id, 100000);
  const key = crypto.randomUUID();
  const r1 = await api('POST', '/transfers', { userId: a.user.id, key, body: { from_wallet_id: a.wallet.id, to_wallet_id: b.wallet.id, amount: 100 } });
  const r2 = await api('POST', '/transfers', { userId: b.user.id, key, body: { from_wallet_id: b.wallet.id, to_wallet_id: a.wallet.id, amount: 100 } });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.notEqual(r1.body.transfer.id, r2.body.transfer.id);
});
