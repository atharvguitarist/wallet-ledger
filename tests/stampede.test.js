'use strict';

// Milestone 2 acceptance test — the stampede.
// ₹500 in one wallet, 100 concurrent ₹10 transfers out of it, 20 runs in a row.
// Each run must give exactly 50 successes, end at ₹0, never go negative, and
// keep total debits equal to total credits.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, startServer, client, createUser, topUp, scalar } = require('./helpers');

const RUNS = Number(process.env.STAMPEDE_RUNS || 20);
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

test(`stampede: 100 concurrent ₹10 transfers from a ₹500 wallet, ${RUNS} runs in a row`, async () => {
  for (let run = 1; run <= RUNS; run += 1) {
    const sender = await createUser(api, `Sender ${run}`);
    const receiver = await createUser(api, `Receiver ${run}`);
    await topUp(api, sender.user.id, sender.wallet.id, 50000); // ₹500

    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        api('POST', '/transfers', {
          userId: sender.user.id,
          body: { from_wallet_id: sender.wallet.id, to_wallet_id: receiver.wallet.id, amount: 1000 }, // ₹10
        })
      )
    );

    const ok = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 422 && r.body.code === 'INSUFFICIENT_FUNDS');
    assert.equal(ok.length, 50, `run ${run}: exactly 50 transfers succeed`);
    assert.equal(rejected.length, 50, `run ${run}: the other 50 are INSUFFICIENT_FUNDS`);

    const stored = await scalar('SELECT balance FROM accounts WHERE id = $1', [sender.wallet.id]);
    assert.equal(stored, 0, `run ${run}: wallet ends at ₹0`);

    // "Never negative": replay the wallet's entries in commit order; the running balance never dips below 0.
    const minRunning = await scalar(
      `SELECT COALESCE(MIN(running), 0)::bigint FROM (
         SELECT SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)
                OVER (ORDER BY id) AS running
           FROM ledger_entries WHERE account_id = $1) s`,
      [sender.wallet.id]
    );
    assert.ok(minRunning >= 0, `run ${run}: running balance never below zero (min ${minRunning})`);

    const { rows: [totals] } = await pool.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)::bigint AS d,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::bigint AS c
         FROM ledger_entries`
    );
    assert.equal(totals.d, totals.c, `run ${run}: total debits equal total credits`);

    const received = await scalar('SELECT balance FROM accounts WHERE id = $1', [receiver.wallet.id]);
    assert.equal(received, 50000, `run ${run}: receiver got exactly ₹500`);
  }
});
