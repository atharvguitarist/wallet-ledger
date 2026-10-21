'use strict';

// Milestone 4 acceptance test.
// Seed 10,000 transfers, corrupt the data directly in the database (change one
// entry's amount, delete one credit, change one stored balance), and the job
// must report exactly those three problems and nothing else.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, scalar } = require('./helpers');
const { seed } = require('../scripts/seed');
const { runReconciliation, getRun } = require('../src/services/reconciliation');

before(async () => {
  await resetDatabase();
  await seed(pool, { users: 200, wallets: 400, transfers: 10000, log: () => {} });
});

after(() => pool.end());

/** Runs SQL as a "rogue" superuser with all triggers switched off for this session. */
async function corrupt(sql, params) {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query(sql, params);
  } finally {
    await client.query("SET session_replication_role = 'origin'");
    client.release();
  }
}

test('clean books -> status ok, zero problems', async () => {
  assert.equal(await scalar('SELECT count(*)::int FROM transfers'), 10000);
  const result = await runReconciliation({ triggeredBy: 'test' });
  assert.equal(result.run.status, 'ok');
  assert.equal(result.run.problem_count, 0);
  assert.equal(result.run.total_debits, result.run.total_credits);
});

test('three corruptions -> exactly three problems, nothing else', async () => {
  // Pick two P2P transfers and an unrelated wallet, all touching different accounts.
  const { rows: picks } = await pool.query(
    `SELECT id, source_account_id AS s, destination_account_id AS d
       FROM transfers WHERE type = 'p2p' ORDER BY id LIMIT 200`
  );
  const t1 = picks[0];
  const t2 = picks.find((t) => ![t1.s, t1.d].includes(t.s) && ![t1.s, t1.d].includes(t.d));
  const used = [t1.s, t1.d, t2.s, t2.d];
  const victim = await scalar(
    `SELECT id FROM accounts WHERE kind = 'user_wallet' AND NOT (id = ANY ($1)) ORDER BY id LIMIT 1`,
    [used]
  );

  // 1. change one entry's amount
  await corrupt(`UPDATE ledger_entries SET amount = amount + 777 WHERE transfer_id = $1 AND direction = 'credit'`, [t1.id]);
  // 2. delete one credit
  await corrupt(`DELETE FROM ledger_entries WHERE transfer_id = $1 AND direction = 'credit'`, [t2.id]);
  // 3. change one stored balance
  await corrupt(`UPDATE accounts SET balance = balance + 12345 WHERE id = $1`, [victim]);

  const result = await runReconciliation({ triggeredBy: 'test' });
  const run = await getRun(pool, result.run.id);
  assert.equal(run.status, 'problems_found');
  assert.equal(run.problem_count, 3);

  const found = run.issues.map((i) => `${i.check_name}:${i.entity_type}:${i.entity_id}`).sort();
  assert.deepEqual(found, [
    `stored_balance:account:${victim}`,
    `transfer_balance:transfer:${t1.id}`,
    `transfer_balance:transfer:${t2.id}`,
  ].sort());

  const byId = Object.fromEntries(run.issues.map((i) => [i.entity_id, i]));
  assert.equal(byId[t1.id].actual - byId[t1.id].expected, 777, 'credit is 777 paise too high');
  assert.equal(byId[t2.id].actual, 0, 'credit side is missing');
  assert.equal(byId[victim].actual - byId[victim].expected, 12345, 'stored balance off by 12345');
});

test('only one run at a time: a held job lock makes the next run exit', async () => {
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE`);
    const result = await runReconciliation({ triggeredBy: 'test' });
    assert.equal(result.skipped, true);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
});
