'use strict';

/*
 * Milestone 4 — check the books every night.
 *
 * All checks run inside ONE REPEATABLE READ transaction, so they all look at
 * the same snapshot even while transfers keep committing. The job only
 * REPORTS problems; it never fixes data.
 *
 * One run at a time: the first statement is
 *     SELECT ... FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE NOWAIT
 * If another run holds that row we get error 55P03 immediately and exit.
 *
 * Root-cause attribution: one bad ledger line shows up in several checks
 * (its transfer is unbalanced, its account's stored balance no longer matches,
 * the global totals are off). We report the root cause once — the unbalanced
 * transfer — and record the knock-on findings in summary.explained instead of
 * as separate problems. An account mismatch is "explained" only if it equals
 * exactly the imbalance of the broken transfers that touch that account, so
 * an independent corruption of the same account is still reported.
 */

const { pool } = require('../db');

const CHECKS = {
  // 1. Everything balances: total debits = total credits.
  ledger_totals: `
    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'),  0)::bigint AS debits,
           COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::bigint AS credits
      FROM ledger_entries`,

  // 2. Every transfer balances, and its lines add up to the transfer amount.
  transfer_balance: `
    SELECT le.transfer_id,
           COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'debit'),  0)::bigint AS debits,
           COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'credit'), 0)::bigint AS credits,
           MAX(t.amount) AS transfer_amount
      FROM ledger_entries le
      LEFT JOIN transfers t ON t.id = le.transfer_id
     GROUP BY le.transfer_id
    HAVING COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'debit'),  0)
        <> COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'credit'), 0)
        OR COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'debit'),  0) <> MAX(t.amount)`,

  // 3. Stored balance = credits - debits computed from the ledger.
  stored_balance: `
    WITH computed AS (
      SELECT account_id,
             SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)::bigint AS balance
        FROM ledger_entries
       GROUP BY account_id
    )
    SELECT a.id AS account_id, a.kind, a.balance AS stored, COALESCE(c.balance, 0)::bigint AS computed
      FROM accounts a
      LEFT JOIN computed c ON c.account_id = a.id
     WHERE a.balance <> COALESCE(c.balance, 0)`,

  // 4. No user wallet's computed balance is below zero.
  no_overdraft: `
    SELECT le.account_id,
           SUM(CASE WHEN le.direction = 'credit' THEN le.amount ELSE -le.amount END)::bigint AS computed
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id AND a.kind = 'user_wallet'
     GROUP BY le.account_id
    HAVING SUM(CASE WHEN le.direction = 'credit' THEN le.amount ELSE -le.amount END) < 0`,

  // 5. Nothing orphaned: money-moving transfers have entries, every entry has
  //    a transfer, and held/rejected transfers have no entries.
  orphans: `
    SELECT 'transfer_without_entries' AS problem, t.id AS entity_id, t.amount
      FROM transfers t
     WHERE t.status IN ('completed', 'reversed')
       AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transfer_id = t.id)
    UNION ALL
    SELECT 'entry_without_transfer', le.id, le.amount
      FROM ledger_entries le
      LEFT JOIN transfers t ON t.id = le.transfer_id
     WHERE t.id IS NULL
    UNION ALL
    SELECT 'unposted_transfer_has_entries', t.id, t.amount
      FROM transfers t
     WHERE t.status IN ('held', 'rejected')
       AND EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transfer_id = t.id)`,
};

async function timed(client, name, sql, params = []) {
  const started = process.hrtime.bigint();
  const { rows } = await client.query(sql, params);
  return { name, rows, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

async function runChecks(client) {
  const results = {};
  for (const [name, sql] of Object.entries(CHECKS)) results[name] = await timed(client, name, sql);

  // Which accounts take part in each unbalanced transfer (from its own
  // source/destination columns AND from whatever entries remain).
  const brokenIds = results.transfer_balance.rows.map((r) => r.transfer_id);
  let parties = [];
  if (brokenIds.length) {
    ({ rows: parties } = await client.query(
      `SELECT id AS transfer_id, source_account_id AS account_id FROM transfers WHERE id = ANY ($1)
       UNION
       SELECT id, destination_account_id FROM transfers WHERE id = ANY ($1)
       UNION
       SELECT transfer_id, account_id FROM ledger_entries WHERE transfer_id = ANY ($1)`,
      [brokenIds]
    ));
  }
  return { results, parties };
}

function attribute({ results, parties }) {
  const problems = [];
  const explained = [];

  // Check 2 -> root causes.
  const imbalance = new Map(); // transfer_id -> credits - debits
  for (const r of results.transfer_balance.rows) {
    imbalance.set(r.transfer_id, r.credits - r.debits);
    const unbalanced = r.debits !== r.credits;
    problems.push({
      check_name: 'transfer_balance',
      entity_type: 'transfer',
      entity_id: r.transfer_id,
      expected: unbalanced ? r.debits : r.transfer_amount,
      actual: unbalanced ? r.credits : r.debits,
      details: { debits: r.debits, credits: r.credits, transfer_amount: r.transfer_amount },
    });
  }

  // How much of each account's drift the broken transfers account for.
  const explainedDrift = new Map(); // account_id -> sum of imbalances of broken transfers it is part of
  for (const p of parties) {
    explainedDrift.set(p.account_id, (explainedDrift.get(p.account_id) || 0) + imbalance.get(p.transfer_id));
  }

  // Check 1.
  const totals = results.ledger_totals.rows[0];
  const globalDrift = totals.credits - totals.debits;
  const driftFromTransfers = [...imbalance.values()].reduce((a, b) => a + b, 0);
  if (globalDrift !== 0) {
    if (globalDrift === driftFromTransfers) {
      explained.push({ check_name: 'ledger_totals', debits: totals.debits, credits: totals.credits, explained_by: 'transfer_balance' });
    } else {
      problems.push({
        check_name: 'ledger_totals', entity_type: 'ledger', entity_id: null,
        expected: totals.debits, actual: totals.credits, details: { unexplained_drift: globalDrift - driftFromTransfers },
      });
    }
  }

  // Check 3.
  for (const r of results.stored_balance.rows) {
    const mismatch = r.stored - r.computed;
    if (explainedDrift.has(r.account_id) && mismatch + explainedDrift.get(r.account_id) === 0) {
      explained.push({ check_name: 'stored_balance', account_id: r.account_id, stored: r.stored, computed: r.computed, explained_by: 'transfer_balance' });
    } else {
      problems.push({
        check_name: 'stored_balance', entity_type: 'account', entity_id: r.account_id,
        expected: r.computed, actual: r.stored, details: { kind: r.kind, difference: mismatch },
      });
    }
  }

  // Check 4: would the wallet still be negative once the broken lines are corrected?
  for (const r of results.no_overdraft.rows) {
    const corrected = r.computed - (explainedDrift.get(r.account_id) || 0);
    if (explainedDrift.has(r.account_id) && corrected >= 0) {
      explained.push({ check_name: 'no_overdraft', account_id: r.account_id, computed: r.computed, explained_by: 'transfer_balance' });
    } else {
      problems.push({
        check_name: 'no_overdraft', entity_type: 'account', entity_id: r.account_id,
        expected: 0, actual: r.computed, details: { rule: 'computed balance must be >= 0' },
      });
    }
  }

  // Check 5.
  for (const r of results.orphans.rows) {
    problems.push({
      check_name: 'orphans',
      entity_type: r.problem === 'entry_without_transfer' ? 'ledger_entry' : 'transfer',
      entity_id: r.entity_id,
      expected: r.problem === 'transfer_without_entries' ? r.amount : 0,
      actual: r.problem === 'transfer_without_entries' ? 0 : r.amount,
      details: { problem: r.problem },
    });
  }

  return { problems, explained, totals };
}

async function runReconciliation({ triggeredBy = 'scheduler' } = {}) {
  const startedAt = new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await client.query(`SELECT id FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE NOWAIT`);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '55P03') return { skipped: true, reason: 'Another reconciliation run is in progress.' };
      throw err;
    }
    await client.query(`UPDATE job_locks SET locked_by = $1, locked_at = now() WHERE job_name = 'reconciliation'`, [triggeredBy]);

    const checked = await runChecks(client);
    const { problems, explained, totals } = attribute(checked);
    const finishedAt = new Date();
    const summary = {
      checks: Object.values(checked.results).map((c) => ({
        name: c.name,
        rows_found: c.name === 'ledger_totals' ? (totals.debits === totals.credits ? 0 : 1) : c.rows.length,
        problems: problems.filter((p) => p.check_name === c.name).length,
        ms: Math.round(c.ms * 10) / 10,
      })),
      explained,
    };

    const { rows: runRows } = await client.query(
      `INSERT INTO reconciliation_runs
         (triggered_by, status, started_at, finished_at, checks_run, problem_count, total_debits, total_credits, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [triggeredBy, problems.length ? 'problems_found' : 'ok', startedAt, finishedAt, Object.keys(CHECKS).length,
        problems.length, totals.debits, totals.credits, JSON.stringify(summary)]
    );
    const run = runRows[0];
    for (const p of problems) {
      await client.query(
        `INSERT INTO reconciliation_issues (run_id, check_name, entity_type, entity_id, expected, actual, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [run.id, p.check_name, p.entity_type, p.entity_id, p.expected, p.actual, JSON.stringify(p.details)]
      );
    }
    await client.query('COMMIT');
    return { skipped: false, run, problems };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(
      `INSERT INTO reconciliation_runs (triggered_by, status, started_at, finished_at, error)
       VALUES ($1, 'failed', $2, now(), $3)`,
      [triggeredBy, startedAt, err.message]
    ).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getRun(db, runId) {
  const { rows } = await db.query('SELECT * FROM reconciliation_runs WHERE id = $1', [runId]);
  if (!rows[0]) return null;
  const { rows: issues } = await db.query('SELECT * FROM reconciliation_issues WHERE run_id = $1 ORDER BY id', [runId]);
  return { ...rows[0], issues };
}

module.exports = { runReconciliation, getRun, CHECKS };
