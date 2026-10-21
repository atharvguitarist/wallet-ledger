'use strict';

/*
 * Milestone 2, Step 2 — "break it first".
 *
 * The naive transfer: read the balance, check it in JavaScript, then write.
 * No transaction, no locks. 100 parallel ₹10 transfers out of a ₹500 wallet.
 *
 *   Variant A  "relative write"  UPDATE ... SET balance = balance - amount
 *              More than 50 requests pass the app's check. The only thing that
 *              stops an overdraft is the CHECK (balance >= 0) on accounts.
 *   Variant B  "absolute write"  UPDATE ... SET balance = <value computed in app>
 *              Classic lost update: requests overwrite each other's balance, so
 *              more than ₹500 leaves while the wallet still shows money.
 *   Fixed      the real moveMoney(): one transaction, SELECT ... FOR UPDATE.
 *
 * Run against a dev database (it creates its own users):  npm run lab:break-it
 */

const crypto = require('crypto');
const { pool, withTransaction } = require('../src/db');
const transfers = require('../src/services/transfers');

const N = 100;
const AMOUNT = 1000; // ₹10
const START = 50000; // ₹500
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeWallets(label) {
  const tag = crypto.randomUUID().slice(0, 8);
  const mk = async (name) => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, phone, kyc_status) VALUES ($1, $2, $3, 'verified') RETURNING id`,
      [`${name} ${label}`, `${name}.${tag}@lab.dev`, `+91${String(Date.now()).slice(-6)}${Math.floor(1000 + Math.random() * 8999)}`]
    );
    const { rows: [w] } = await pool.query(`INSERT INTO accounts (kind, user_id, name) VALUES ('user_wallet', $1, 'main') RETURNING id`, [u.id]);
    return { userId: u.id, walletId: w.id };
  };
  const from = await mk('Racer');
  const to = await mk('Sink');
  await withTransaction((c) => transfers.topUp(c, { walletId: from.walletId, amount: START, userId: from.userId }));
  return { from, to };
}

/** The broken transfer. Every query autocommits on its own; nothing is locked. */
async function unsafeTransfer(fromId, toId, mode) {
  const { rows } = await pool.query('SELECT balance FROM accounts WHERE id = $1', [fromId]);
  const balance = rows[0].balance;
  if (balance < AMOUNT) return 'rejected_by_app';
  await sleep(2); // the gap between "check" and "write" (a network hop, a GC pause...)
  try {
    if (mode === 'relative') {
      await pool.query('UPDATE accounts SET balance = balance - $2 WHERE id = $1', [fromId, AMOUNT]);
    } else {
      await pool.query('UPDATE accounts SET balance = $2 WHERE id = $1', [fromId, balance - AMOUNT]);
    }
  } catch (err) {
    if (err.constraint === 'accounts_wallet_non_negative') return 'blocked_by_db_check';
    throw err;
  }
  await pool.query('UPDATE accounts SET balance = balance + $2 WHERE id = $1', [toId, AMOUNT]);
  return 'ok';
}

async function report(title, from, to, outcomes) {
  const count = (o) => outcomes.filter((x) => x === o).length;
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT balance FROM accounts WHERE id = $1) AS sender, (SELECT balance FROM accounts WHERE id = $2) AS receiver`,
    [from.walletId, to.walletId]
  );
  const created = r.sender + r.receiver - START;
  console.log(`\n${title}`);
  console.log(`  succeeded: ${count('ok')}   rejected by app: ${count('rejected_by_app') + count('INSUFFICIENT_FUNDS')}   blocked by DB CHECK: ${count('blocked_by_db_check')}`);
  console.log(`  sender balance: ${r.sender} paise   receiver balance: ${r.receiver} paise`);
  console.log(`  money created out of thin air: ${created} paise (₹${created / 100})`);
}

async function main() {
  // Variant A
  let w = await makeWallets('A');
  let outcomes = await Promise.all(Array.from({ length: N }, () => unsafeTransfer(w.from.walletId, w.to.walletId, 'relative')));
  await report('Variant A — no lock, relative UPDATE (balance = balance - amount)', w.from, w.to, outcomes);

  // Variant B
  w = await makeWallets('B');
  outcomes = await Promise.all(Array.from({ length: N }, () => unsafeTransfer(w.from.walletId, w.to.walletId, 'absolute')));
  await report('Variant B — no lock, absolute UPDATE (balance = value computed in app)', w.from, w.to, outcomes);

  // Fixed
  w = await makeWallets('Fixed');
  outcomes = await Promise.all(
    Array.from({ length: N }, () =>
      withTransaction((c) => transfers.peerTransfer(c, { fromWalletId: w.from.walletId, toWalletId: w.to.walletId, amount: AMOUNT, userId: w.from.userId }))
        .then(() => 'ok', (err) => err.code || err.message)
    )
  );
  await report('Fixed — one transaction, SELECT ... FOR UPDATE in id order (src/services/transfers.js)', w.from, w.to, outcomes);
  console.log('\nNote: variants A and B bypass the ledger on purpose; run the reconciliation job afterwards and it will flag both wallets.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
