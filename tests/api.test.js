'use strict';

// API contract: error shape, validation, statements and pagination, withdrawals.

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

const SHAPE = ['code', 'message', 'request_id'];

test('every error uses { code, message, request_id }', async () => {
  const a = await createUser(api, 'Shape Test');
  const cases = [
    await api('POST', '/transfers', { userId: a.user.id, body: { from_wallet_id: a.wallet.id, to_wallet_id: 99999, amount: 100 } }),
    await api('POST', `/wallets/${a.wallet.id}/topup`, { userId: a.user.id, body: { amount: 10.5 } }),
    await api('POST', `/wallets/${a.wallet.id}/topup`, { userId: a.user.id, body: { amount: '500' } }),
    await api('GET', `/wallets/${a.wallet.id}/balance`),
    await api('GET', '/admin/reconciliation/runs'),
    await api('GET', '/nope'),
  ];
  assert.deepEqual(cases.map((c) => c.status), [404, 400, 400, 401, 403, 404]);
  for (const c of cases) assert.deepEqual(Object.keys(c.body).sort(), SHAPE);
  assert.equal(cases[1].body.code, 'INVALID_AMOUNT');
});

test('you cannot spend from someone else\'s wallet', async () => {
  const a = await createUser(api, 'Owner');
  const b = await createUser(api, 'Thief');
  await topUp(api, a.user.id, a.wallet.id, 10000);
  const r = await api('POST', '/transfers', { userId: b.user.id, body: { from_wallet_id: a.wallet.id, to_wallet_id: b.wallet.id, amount: 100 } });
  assert.equal(r.status, 403);
  assert.equal(await scalar('SELECT balance FROM accounts WHERE id = $1', [a.wallet.id]), 10000);
});

test('withdrawal moves money to cash-out and charges a separate fee transfer', async () => {
  const a = await createUser(api, 'Withdraw');
  await topUp(api, a.user.id, a.wallet.id, 10000);
  const r = await api('POST', `/wallets/${a.wallet.id}/withdraw`, { userId: a.user.id, body: { amount: 5000 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.fee.type, 'fee');
  assert.equal(r.body.fee.related_transfer_id, r.body.transfer.id);
  assert.equal(r.body.wallet_balance, 10000 - 5000 - 200);
  const tooMuch = await api('POST', `/wallets/${a.wallet.id}/withdraw`, { userId: a.user.id, body: { amount: 4800 } }); // 4800 + 200 fee > 4800
  assert.equal(tooMuch.status, 422);
  assert.equal(tooMuch.body.code, 'INSUFFICIENT_FUNDS');
});

test('a user can have several wallets and move money between them', async () => {
  const a = await createUser(api, 'Multi Wallet');
  const w = await api('POST', `/users/${a.user.id}/wallets`, { userId: a.user.id, body: { name: 'savings' } });
  assert.equal(w.status, 201);
  const dup = await api('POST', `/users/${a.user.id}/wallets`, { userId: a.user.id, body: { name: 'savings' } });
  assert.equal(dup.status, 409);
  await topUp(api, a.user.id, a.wallet.id, 3000);
  const t = await api('POST', '/transfers', { userId: a.user.id, body: { from_wallet_id: a.wallet.id, to_wallet_id: w.body.wallet.id, amount: 1000 } });
  assert.equal(t.status, 201);
  const list = await api('GET', `/users/${a.user.id}/wallets`, { userId: a.user.id });
  assert.deepEqual(list.body.wallets.map((x) => x.balance), [2000, 1000]);
});

test('statement: newest first; offset and cursor pages agree', async () => {
  const a = await createUser(api, 'Statement');
  const b = await createUser(api, 'Statement Peer');
  await topUp(api, a.user.id, a.wallet.id, 100000);
  for (let i = 1; i <= 24; i += 1) {
    await api('POST', '/transfers', { userId: a.user.id, body: { from_wallet_id: a.wallet.id, to_wallet_id: b.wallet.id, amount: i * 10, note: `#${i}` } });
  }
  const p1 = await api('GET', `/wallets/${a.wallet.id}/statement?limit=10`, { userId: a.user.id });
  assert.equal(p1.body.entries.length, 10);
  assert.equal(p1.body.entries[0].note, '#24');
  assert.equal(p1.body.entries[0].signed_amount, -240);

  const byOffset = await api('GET', `/wallets/${a.wallet.id}/statement?limit=10&offset=10`, { userId: a.user.id });
  const byCursor = await api('GET', `/wallets/${a.wallet.id}/statement?limit=10&cursor=${p1.body.pagination.next_cursor}`, { userId: a.user.id });
  assert.deepEqual(byCursor.body.entries.map((e) => e.entry_id), byOffset.body.entries.map((e) => e.entry_id));

  const all = [];
  let cursor = '';
  for (;;) {
    const page = await api('GET', `/wallets/${a.wallet.id}/statement?limit=7${cursor ? `&cursor=${cursor}` : ''}`, { userId: a.user.id });
    all.push(...page.body.entries);
    if (!page.body.pagination.next_cursor) break;
    cursor = page.body.pagination.next_cursor;
  }
  assert.equal(all.length, 25, '24 transfers + 1 top-up');
  assert.equal(new Set(all.map((e) => e.entry_id)).size, 25, 'no duplicates across pages');
});
