'use strict';

/*
 * ============================  THE MONEY PATH  ============================
 *
 * Every function in this file runs inside ONE database transaction that the
 * caller has already opened (READ COMMITTED). Nothing here commits. The
 * caller commits at the end, or rolls back if anything throws, so a transfer
 * either fully happens or leaves no trace.
 *
 * The recipe for every movement of money:
 *   1. Lock the account rows with SELECT ... FOR UPDATE, lowest id first.
 *      (Two transfers A->B and B->A both lock min(A,B) first, so they queue
 *      instead of deadlocking.)
 *   2. Re-read the balance while holding the lock and reject if too low.
 *   3. Run the fraud rules (still inside the transaction).
 *   4. INSERT the transfer, INSERT its debit + credit ledger lines, UPDATE
 *      the two stored balances.
 *   5. Return. The caller COMMITs.
 *
 * Plain SQL on purpose: you can see every query, every lock and every write.
 * ==========================================================================
 */

const config = require('../config');
const { AppError } = require('../errors');
const { formatPaise } = require('../money');
const { evaluateRisk, recordFlags } = require('./risk');

async function systemAccountId(client, code) {
  const { rows } = await client.query('SELECT id FROM accounts WHERE system_code = $1', [code]);
  if (!rows[0]) throw new Error(`system account ${code} is missing; did the migrations run?`);
  return rows[0].id;
}

/** Step 1: lock rows one by one in ascending id order. Returns Map<id, row>. */
async function lockAccounts(client, accountIds) {
  const ordered = [...new Set(accountIds.map(Number))].sort((a, b) => a - b);
  const locked = new Map();
  for (const id of ordered) {
    const { rows } = await client.query(
      `SELECT a.id, a.kind, a.user_id, a.system_code, a.name, a.balance, u.kyc_status
         FROM accounts a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.id = $1
          FOR UPDATE OF a`,
      [id]
    );
    if (!rows[0]) throw new AppError(404, 'WALLET_NOT_FOUND', `Wallet ${id} does not exist.`);
    locked.set(id, rows[0]);
  }
  return locked;
}

/** Step 2: system accounts may go negative; user wallets may not. */
function assertSufficientFunds(account, needed) {
  if (account.kind === 'user_wallet' && account.balance < needed) {
    throw new AppError(
      422,
      'INSUFFICIENT_FUNDS',
      `Wallet ${account.id} has ${formatPaise(account.balance)} but this needs ${formatPaise(needed)}.`
    );
  }
}

async function insertTransfer(client, t) {
  const { rows } = await client.query(
    `INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id,
                            related_transfer_id, initiated_by_user_id, note, flagged)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      t.type,
      t.status,
      t.amount,
      t.sourceId,
      t.destinationId,
      t.relatedTransferId ?? null,
      t.initiatedByUserId ?? null,
      t.note ?? null,
      t.flagged ?? false,
    ]
  );
  return rows[0];
}

/** Step 4: two ledger lines + two stored balances. Returns new balances. */
async function postLedger(client, transfer) {
  await client.query(
    `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
     VALUES ($1, $2, 'debit',  $4),
            ($1, $3, 'credit', $4)`,
    [transfer.id, transfer.source_account_id, transfer.destination_account_id, transfer.amount]
  );
  // The CHECK (kind = 'system' OR balance >= 0) on accounts is a second line of
  // defence: even if step 2 had a bug, this UPDATE would fail for a wallet.
  const debited = await client.query(
    'UPDATE accounts SET balance = balance - $2, updated_at = now() WHERE id = $1 RETURNING balance',
    [transfer.source_account_id, transfer.amount]
  );
  const credited = await client.query(
    'UPDATE accounts SET balance = balance + $2, updated_at = now() WHERE id = $1 RETURNING balance',
    [transfer.destination_account_id, transfer.amount]
  );
  return {
    [transfer.source_account_id]: debited.rows[0].balance,
    [transfer.destination_account_id]: credited.rows[0].balance,
  };
}

/**
 * Move `amount` paise from sourceId to destinationId. The core of every
 * top-up, P2P transfer, withdrawal, fee and reversal.
 */
async function moveMoney(
  client,
  { type, sourceId, destinationId, amount, note = null, initiatedByUserId = null, relatedTransferId = null, checkRisk = true }
) {
  if (Number(sourceId) === Number(destinationId)) {
    throw new AppError(422, 'SAME_WALLET', 'Source and destination must be different wallets.');
  }

  // 1. Lock both rows, lowest id first.
  const locked = await lockAccounts(client, [sourceId, destinationId]);
  const source = locked.get(Number(sourceId));
  const destination = locked.get(Number(destinationId));

  // 2. Balance check on the row we just locked; nobody else can change it now.
  assertSufficientFunds(source, amount);

  // 3. Fraud rules, only for money leaving a user's wallet.
  const decision =
    checkRisk && source.kind === 'user_wallet'
      ? await evaluateRisk(client, { type, source, destination, amount })
      : { action: 'allow', hits: [] };

  if (decision.action === 'hold') {
    // Held: the transfer exists for review but NO ledger lines, NO balance change.
    const transfer = await insertTransfer(client, {
      type, status: 'held', amount, sourceId, destinationId, relatedTransferId, initiatedByUserId, note, flagged: true,
    });
    await recordFlags(client, transfer.id, decision.hits);
    return {
      transfer,
      held: true,
      flags: decision.hits,
      balances: { [source.id]: source.balance, [destination.id]: destination.balance },
    };
  }

  // 4. Write the transfer, its balanced entries and the new stored balances.
  const transfer = await insertTransfer(client, {
    type, status: 'completed', amount, sourceId, destinationId, relatedTransferId, initiatedByUserId, note,
    flagged: decision.hits.length > 0,
  });
  const balances = await postLedger(client, transfer);
  await recordFlags(client, transfer.id, decision.hits);
  return { transfer, held: false, flags: decision.hits, balances };
}

// ---------------------------------------------------------------------------
// Operations built on moveMoney
// ---------------------------------------------------------------------------

async function topUp(client, { walletId, amount, note, userId }) {
  const cashIn = await systemAccountId(client, 'cash_in');
  return moveMoney(client, {
    type: 'topup', sourceId: cashIn, destinationId: walletId, amount, note, initiatedByUserId: userId,
  });
}

async function peerTransfer(client, { fromWalletId, toWalletId, amount, note, userId }) {
  return moveMoney(client, {
    type: 'p2p', sourceId: fromWalletId, destinationId: toWalletId, amount, note, initiatedByUserId: userId,
  });
}

/** Withdrawal = wallet -> cash_out, plus a separate fee transfer wallet -> fee_revenue. */
async function withdraw(client, { walletId, amount, note, userId }) {
  const fee = config.withdrawalFeePaise;
  const cashOut = await systemAccountId(client, 'cash_out');
  const feeAccount = await systemAccountId(client, 'fee_revenue');

  // Lock every row this operation touches up front, in ascending order.
  const locked = await lockAccounts(client, fee > 0 ? [walletId, cashOut, feeAccount] : [walletId, cashOut]);
  assertSufficientFunds(locked.get(Number(walletId)), amount + fee);

  const result = await moveMoney(client, {
    type: 'withdrawal', sourceId: walletId, destinationId: cashOut, amount, note, initiatedByUserId: userId,
  });
  if (!result.held && fee > 0) {
    result.fee = await chargeFee(client, result.transfer, feeAccount);
    Object.assign(result.balances, result.fee.balances);
  }
  return result;
}

async function chargeFee(client, withdrawal, feeAccountId) {
  return moveMoney(client, {
    type: 'fee',
    sourceId: withdrawal.source_account_id,
    destinationId: feeAccountId ?? (await systemAccountId(client, 'fee_revenue')),
    amount: config.withdrawalFeePaise,
    note: `Withdrawal fee for transfer ${withdrawal.id}`,
    initiatedByUserId: withdrawal.initiated_by_user_id,
    relatedTransferId: withdrawal.id,
    checkRisk: false,
  });
}

async function lockTransfer(client, transferId) {
  const { rows } = await client.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [transferId]);
  if (!rows[0]) throw new AppError(404, 'TRANSFER_NOT_FOUND', `Transfer ${transferId} does not exist.`);
  return rows[0];
}

/** Admin releases a held transfer: now the money actually moves. */
async function releaseHeld(client, transferId) {
  // Lock order everywhere: transfer row first, then account rows (ascending).
  const transfer = await lockTransfer(client, transferId);
  if (transfer.status !== 'held') {
    throw new AppError(409, 'INVALID_TRANSFER_STATE', `Transfer ${transferId} is ${transfer.status}, not held.`);
  }
  const fee = transfer.type === 'withdrawal' ? config.withdrawalFeePaise : 0;
  const feeAccount = fee > 0 ? await systemAccountId(client, 'fee_revenue') : null;
  const ids = [transfer.source_account_id, transfer.destination_account_id];
  if (feeAccount) ids.push(feeAccount);

  const locked = await lockAccounts(client, ids);
  assertSufficientFunds(locked.get(transfer.source_account_id), transfer.amount + fee);

  const balances = await postLedger(client, transfer);
  const { rows } = await client.query(`UPDATE transfers SET status = 'completed' WHERE id = $1 RETURNING *`, [transferId]);
  const result = { transfer: rows[0], held: false, flags: [], balances };
  if (fee > 0) {
    result.fee = await chargeFee(client, rows[0], feeAccount);
    Object.assign(result.balances, result.fee.balances);
  }
  return result;
}

/** Admin rejects a held transfer. No money ever moved, so nothing to undo. */
async function rejectHeld(client, transferId) {
  const transfer = await lockTransfer(client, transferId);
  if (transfer.status !== 'held') {
    throw new AppError(409, 'INVALID_TRANSFER_STATE', `Transfer ${transferId} is ${transfer.status}, not held.`);
  }
  const { rows } = await client.query(`UPDATE transfers SET status = 'rejected' WHERE id = $1 RETURNING *`, [transferId]);
  return { transfer: rows[0] };
}

/**
 * Fix a mistake without touching history: a NEW reversal transfer moves the
 * money back and points to the original, which is marked 'reversed'.
 */
async function reverse(client, transferId, { note } = {}) {
  const original = await lockTransfer(client, transferId);
  if (original.type === 'reversal') {
    throw new AppError(409, 'CANNOT_REVERSE_REVERSAL', 'A reversal cannot itself be reversed.');
  }
  if (original.status !== 'completed') {
    throw new AppError(409, 'INVALID_TRANSFER_STATE', `Only completed transfers can be reversed; ${transferId} is ${original.status}.`);
  }
  const result = await moveMoney(client, {
    type: 'reversal',
    sourceId: original.destination_account_id,
    destinationId: original.source_account_id,
    amount: original.amount,
    note: note || `Reversal of transfer ${original.id}`,
    relatedTransferId: original.id,
    checkRisk: false,
  });
  await client.query(`UPDATE transfers SET status = 'reversed' WHERE id = $1`, [original.id]);
  return result;
}

module.exports = {
  systemAccountId,
  lockAccounts,
  moveMoney,
  topUp,
  peerTransfer,
  withdraw,
  releaseHeld,
  rejectHeld,
  reverse,
};
