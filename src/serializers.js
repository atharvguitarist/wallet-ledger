'use strict';

const { formatPaise } = require('./money');

function transferView(t, extra = {}) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    amount: t.amount,
    amount_formatted: formatPaise(t.amount),
    from_wallet_id: t.source_account_id,
    to_wallet_id: t.destination_account_id,
    related_transfer_id: t.related_transfer_id,
    note: t.note,
    flagged: t.flagged,
    created_at: t.created_at,
    ...extra,
  };
}

/** Response body for anything that went through moveMoney(). */
function movementView(result, walletId) {
  const body = {
    transfer: transferView(result.transfer, { risk_flags: result.flags.map((f) => ({ rule: f.code, action: f.action })) }),
  };
  if (result.fee) body.fee = transferView(result.fee.transfer);
  if (walletId !== undefined && result.balances[walletId] !== undefined) {
    body.wallet_balance = result.balances[walletId];
    body.wallet_balance_formatted = formatPaise(result.balances[walletId]);
  }
  if (result.held) body.message = 'Transfer is held for review. No money has moved yet.';
  return body;
}

function walletView(a) {
  return {
    id: a.id,
    user_id: a.user_id,
    name: a.name,
    currency: a.currency,
    balance: a.balance,
    balance_formatted: formatPaise(a.balance),
    created_at: a.created_at,
  };
}

function userView(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, kyc_status: u.kyc_status, created_at: u.created_at };
}

module.exports = { transferView, movementView, walletView, userView };
