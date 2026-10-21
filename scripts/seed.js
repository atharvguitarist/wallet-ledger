'use strict';

/*
 * Seed script. Default: 1,000 users, 2,000 wallets, 100,000 transfers.
 *
 *   npm run seed                                   (defaults)
 *   npm run seed -- --users 2000 --transfers 500000  (≈1 million ledger entries)
 *   npm run seed -- --reset                        (wipe users/transfers first; dev only)
 *
 * Set-based SQL (INSERT ... SELECT generate_series) instead of 100,000 API
 * calls, so it finishes in seconds. The data still obeys every rule: each
 * transfer gets one debit + one credit (the deferred balance trigger checks
 * every one at COMMIT), every wallet starts with a ₹1,00,000 top-up so no
 * wallet goes negative, and stored balances are recomputed from the ledger.
 * Timestamps are spread over the last 90 days so statements and the Q&A
 * endpoint have history to work with.
 */

const { Pool } = require('pg');

const FIRST = ['Asha', 'Rahul', 'Priya', 'Arjun', 'Neha', 'Vikram', 'Ananya', 'Rohan', 'Kavya', 'Aditya',
  'Ishita', 'Karan', 'Meera', 'Siddharth', 'Pooja', 'Aman', 'Diya', 'Nikhil', 'Sneha', 'Varun'];
const LAST = ['Sharma', 'Verma', 'Mehta', 'Iyer', 'Nair', 'Reddy', 'Gupta', 'Singh', 'Patel', 'Rao',
  'Kapoor', 'Joshi', 'Das', 'Menon', 'Bose', 'Kulkarni', 'Chopra', 'Malhotra', 'Pillai', 'Saxena'];
const NOTES = ['dinner', 'rent share', 'groceries', 'movie tickets', 'cab', 'birthday gift', 'electricity bill',
  'coffee', 'books', 'trip to Goa', 'lunch', 'gym fee', 'pizza', 'concert', 'medicine'];

const sqlArray = (items) => `ARRAY[${items.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')}]`;

async function seed(pool, { users = 1000, wallets = 2000, transfers = 100000, batch = 50000, log = console.log } = {}) {
  if (wallets < users) throw new Error('need at least one wallet per user');
  const t0 = Date.now();
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.actor', 'seed', false)");
    const userOffset = Number((await client.query('SELECT COALESCE(MAX(id), 0) AS m FROM users')).rows[0].m);

    // Users: unique email/phone; every 10th user has KYC pending.
    await client.query(
      `INSERT INTO users (name, email, phone, kyc_status, created_at)
       SELECT (${sqlArray(FIRST)})[1 + (g % ${FIRST.length})] || ' ' || (${sqlArray(LAST)})[1 + ((g / ${FIRST.length}) % ${LAST.length})],
              'seed.user' || ($1 + g) || '@example.com',
              '+916' || lpad(($1 + g)::text, 9, '0'),
              CASE WHEN g % 10 = 0 THEN 'pending' ELSE 'verified' END,
              now() - interval '120 days'
         FROM generate_series(1, $2) g`,
      [userOffset, users]
    );
    log(`[seed] ${users} users`);

    // Wallets: every new user gets 'main'; the rest are 'savings', 'travel', ... spread round-robin.
    await client.query(
      `WITH new_users AS (
         SELECT id, row_number() OVER (ORDER BY id) AS rn FROM users WHERE id > $1
       ), slots AS (
         SELECT g, ((g - 1) % $2) + 1 AS user_rn, ((g - 1) / $2) AS nth FROM generate_series(1, $3) g
       )
       INSERT INTO accounts (kind, user_id, name, created_at)
       SELECT 'user_wallet', u.id,
              CASE s.nth WHEN 0 THEN 'main' WHEN 1 THEN 'savings' ELSE 'wallet-' || (s.nth + 1) END,
              now() - interval '120 days'
         FROM slots s JOIN new_users u ON u.rn = s.user_rn`,
      [userOffset, users, wallets]
    );
    await client.query(`CREATE TEMP TABLE seed_wallets AS
      SELECT id, row_number() OVER (ORDER BY id) AS rn FROM accounts
       WHERE kind = 'user_wallet' AND user_id > $1`, [userOffset]);
    await client.query('CREATE UNIQUE INDEX ON seed_wallets (rn)');
    log(`[seed] ${wallets} wallets`);

    const ids = (await client.query(`SELECT system_code, id FROM accounts WHERE kind = 'system'`)).rows;
    const sys = Object.fromEntries(ids.map((r) => [r.system_code, r.id]));

    // Opening top-up of ₹1,00,000 for every wallet, 90 days ago.
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id, note, created_at)
       SELECT 'topup', 'completed', 10000000, $1, w.id, 'opening balance', now() - interval '90 days'
         FROM seed_wallets w`,
      [sys.cash_in]
    );
    await postEntriesForNewTransfers(client);
    await client.query('COMMIT');

    // Random history: 82% P2P, 12% top-ups, 6% withdrawals; ₹1 – ₹500 each.
    const remaining = Math.max(transfers - wallets, 0);
    for (let done = 0; done < remaining; done += batch) {
      const n = Math.min(batch, remaining - done);
      await client.query('BEGIN');
      await client.query(
        `WITH g AS (
           SELECT random() AS r,
                  1 + floor(random() * $1::int)::int AS a,
                  1 + floor(random() * ($1::int - 1))::int AS b,
                  100 + floor(random() * 49900)::bigint AS amount,
                  now() - random() * interval '89 days' AS ts,
                  (${sqlArray(NOTES)})[1 + floor(random() * ${NOTES.length})::int] AS note
             FROM generate_series(1, $2::int)
         )
         INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id, note, created_at)
         SELECT CASE WHEN g.r < 0.82 THEN 'p2p' WHEN g.r < 0.94 THEN 'topup' ELSE 'withdrawal' END,
                'completed',
                g.amount,
                CASE WHEN g.r < 0.82 THEN wa.id WHEN g.r < 0.94 THEN $3::bigint ELSE wa.id END,
                CASE WHEN g.r < 0.82 THEN wb.id WHEN g.r < 0.94 THEN wa.id ELSE $4::bigint END,
                CASE WHEN g.r < 0.82 THEN g.note END,
                g.ts
           FROM g
           JOIN seed_wallets wa ON wa.rn = g.a
           -- b is drawn from 1..n-1 and shifted past a, so source <> destination
           JOIN seed_wallets wb ON wb.rn = CASE WHEN g.b >= g.a THEN g.b + 1 ELSE g.b END`,
        [wallets, n, sys.cash_in, sys.cash_out]
      );
      await postEntriesForNewTransfers(client);
      await client.query('COMMIT');
      log(`[seed] ${Math.min(wallets + done + n, transfers)} / ${transfers} transfers (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }

    // Stored balances = what the ledger says.
    await client.query(
      `UPDATE accounts a
          SET balance = c.balance, updated_at = now()
         FROM (SELECT account_id, SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)::bigint AS balance
                 FROM ledger_entries GROUP BY account_id) c
        WHERE c.account_id = a.id AND a.balance <> c.balance`
    );
    await client.query('DROP TABLE seed_wallets');
    await client.query('ANALYZE');
    log(`[seed] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Debit + credit lines for every transfer that has none yet, with the transfer's timestamp. */
async function postEntriesForNewTransfers(client) {
  await client.query(
    `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, created_at)
     SELECT t.id, x.account_id, x.direction, t.amount, t.created_at
       FROM transfers t
      CROSS JOIN LATERAL (VALUES (t.source_account_id, 'debit'), (t.destination_account_id, 'credit')) AS x(account_id, direction)
      WHERE t.status = 'completed'
        AND t.id > COALESCE((SELECT MAX(transfer_id) FROM ledger_entries), 0)
      ORDER BY t.id, x.direction DESC`
  );
}

async function resetData(pool) {
  // Dev-only wipe. The ledger is append-only, so the guard triggers are
  // switched off for this one session only (needs a superuser, like the
  // default docker-compose user).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(`TRUNCATE ledger_entries, transfer_status_history, risk_flags, idempotency_keys,
                        reconciliation_issues, reconciliation_runs, transfers RESTART IDENTITY`);
    await client.query(`DELETE FROM accounts WHERE kind = 'user_wallet'`);
    await client.query(`UPDATE accounts SET balance = 0`);
    await client.query(`DELETE FROM users`);
    await client.query(`ALTER TABLE users ALTER COLUMN id RESTART`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seed, resetData, postEntriesForNewTransfers };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : Number(args[i + 1]);
  };
  const config = require('../src/config');
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  (async () => {
    if (args.includes('--reset')) {
      await resetData(pool);
      console.log('[seed] existing data wiped');
    }
    await seed(pool, { users: opt('users', 1000), wallets: opt('wallets', 2000), transfers: opt('transfers', 100000) });
  })()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
