'use strict';

const { AppError } = require('../errors');
const { formatPaise } = require('../money');

// One SELECT for both pagination styles. The counterparty is the other side
// of the transfer: for a debit it's where money went, for a credit where it came from.
const BASE_SELECT = `
  SELECT le.id                     AS entry_id,
         le.transfer_id,
         le.direction,
         le.amount,
         le.created_at,
         le.created_at::text       AS cursor_ts,
         t.type,
         t.status,
         t.note,
         cp.id                     AS counterparty_account_id,
         COALESCE(cu.name, cp.name) AS counterparty
    FROM ledger_entries le
    JOIN transfers t  ON t.id  = le.transfer_id
    JOIN accounts  cp ON cp.id = CASE WHEN le.direction = 'debit'
                                      THEN t.destination_account_id
                                      ELSE t.source_account_id END
    LEFT JOIN users cu ON cu.id = cp.user_id`;

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: row.cursor_ts, i: row.entry_id })).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const { t, i } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof t !== 'string' || !Number.isSafeInteger(i)) throw new Error('bad cursor');
    return { t, i };
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid; use the next_cursor value from a previous page.');
  }
}

function toEntry(row) {
  return {
    entry_id: row.entry_id,
    transfer_id: row.transfer_id,
    type: row.type,
    status: row.status,
    direction: row.direction,
    amount: row.amount,
    signed_amount: row.direction === 'credit' ? row.amount : -row.amount,
    amount_formatted: formatPaise(row.amount),
    counterparty: row.counterparty,
    counterparty_wallet_id: row.counterparty_account_id,
    note: row.note,
    created_at: row.created_at,
  };
}

/**
 * Newest first. Two modes:
 *   offset: ORDER BY created_at DESC, id DESC LIMIT n OFFSET m   (simple, slow for deep pages)
 *   cursor: WHERE (created_at, id) < (cursor) ORDER BY ... LIMIT n  (keyset, constant speed)
 */
async function getStatement(db, walletId, { limit = 20, offset = 0, cursor } = {}) {
  let rows;
  if (cursor) {
    const c = decodeCursor(cursor);
    ({ rows } = await db.query(
      `${BASE_SELECT}
        WHERE le.account_id = $1
          AND (le.created_at, le.id) < ($2::timestamptz, $3::bigint)
        ORDER BY le.created_at DESC, le.id DESC
        LIMIT $4`,
      [walletId, c.t, c.i, limit]
    ));
  } else {
    ({ rows } = await db.query(
      `${BASE_SELECT}
        WHERE le.account_id = $1
        ORDER BY le.created_at DESC, le.id DESC
        LIMIT $2 OFFSET $3`,
      [walletId, limit, offset]
    ));
  }
  const hasMore = rows.length === limit;
  return {
    wallet_id: walletId,
    entries: rows.map(toEntry),
    pagination: cursor
      ? { mode: 'cursor', limit, next_cursor: hasMore ? encodeCursor(rows[rows.length - 1]) : null }
      : {
          mode: 'offset',
          limit,
          offset,
          next_offset: hasMore ? offset + limit : null,
          next_cursor: hasMore ? encodeCursor(rows[rows.length - 1]) : null,
        },
  };
}

module.exports = { getStatement, BASE_SELECT };
