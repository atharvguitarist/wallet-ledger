'use strict';

/*
 * How much time do the fraud rules add to a transfer?
 * Runs N transfers with every rule enabled, then N with every rule disabled,
 * through the real money path (one transaction each), and prints median and
 * p95 latency plus the time spent in each rule query on its own.
 *
 *   npm run perf:rules           (use a seeded dev database, NOT production)
 */

const { pool, withTransaction } = require('../src/db');
const transfers = require('../src/services/transfers');

const N = Number(process.env.N || 400);

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function wallets() {
  const { rows } = await pool.query(
    `SELECT a.id, a.user_id FROM accounts a JOIN users u ON u.id = a.user_id
      WHERE a.kind = 'user_wallet' AND u.kyc_status = 'verified' AND a.balance > 100000
      ORDER BY a.id LIMIT 400`
  );
  if (rows.length < 50) throw new Error('Seed the database first: npm run seed');
  return rows;
}

async function timeTransfers(ws) {
  const times = [];
  for (let i = 0; i < N; i += 1) {
    const from = ws[i % ws.length];
    const to = ws[(i * 7 + 3) % ws.length];
    if (from.id === to.id) continue;
    const t0 = process.hrtime.bigint();
    await withTransaction((c) => transfers.peerTransfer(c, { fromWalletId: from.id, toWalletId: to.id, amount: 100, userId: from.user_id }));
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return times;
}

async function timeQuery(sql, params, reps = 200) {
  const times = [];
  for (let i = 0; i < reps; i += 1) {
    const t0 = process.hrtime.bigint();
    await pool.query(sql, params);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return pct(times, 50);
}

async function main() {
  const ws = await wallets();
  const { rows: rules } = await pool.query('SELECT code, enabled FROM risk_rules');
  try {
    await timeTransfers(ws.slice(0, 20)); // warm-up
    await pool.query('UPDATE risk_rules SET enabled = true');
    const on = await timeTransfers(ws);
    await pool.query('UPDATE risk_rules SET enabled = false');
    const off = await timeTransfers(ws);

    const f = ws[0].id;
    const t = ws[1].id;
    const perRule = {
      velocity: await timeQuery(`SELECT count(*)::int FROM transfers WHERE source_account_id = $1 AND created_at > now() - make_interval(secs => 60)`, [f]),
      daily_limit: await timeQuery(`SELECT COALESCE(SUM(amount),0)::bigint FROM transfers WHERE source_account_id = $1 AND status IN ('completed','held') AND created_at > now() - make_interval(secs => 86400)`, [f]),
      new_payee_large: await timeQuery(`SELECT EXISTS (SELECT 1 FROM transfers WHERE source_account_id = $1 AND destination_account_id = $2 AND status = 'completed')`, [f, t]),
      load_rules: await timeQuery(`SELECT id, code, action, amount_threshold, count_threshold, window_seconds FROM risk_rules WHERE enabled AND $1 = ANY (applies_to) ORDER BY id`, ['p2p']),
    };

    console.log(`Transfers per configuration: ${on.length}`);
    console.log('| Configuration | median ms | p95 ms |');
    console.log('|---|---:|---:|');
    console.log(`| all rules enabled | ${pct(on, 50).toFixed(2)} | ${pct(on, 95).toFixed(2)} |`);
    console.log(`| all rules disabled | ${pct(off, 50).toFixed(2)} | ${pct(off, 95).toFixed(2)} |`);
    console.log(`| **added by rules** | **${(pct(on, 50) - pct(off, 50)).toFixed(2)}** | ${(pct(on, 95) - pct(off, 95)).toFixed(2)} |`);
    console.log('\nSingle query, median of 200 (ms, incl. client round trip):');
    for (const [k, v] of Object.entries(perRule)) console.log(`  ${k.padEnd(16)} ${v.toFixed(3)}`);
  } finally {
    for (const r of rules) await pool.query('UPDATE risk_rules SET enabled = $2 WHERE code = $1', [r.code, r.enabled]);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
