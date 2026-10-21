'use strict';

const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../errors');
const { idempotent } = require('../idempotency');
const { requireUser, idParam } = require('../middleware');
const { parseAmount, formatPaise } = require('../money');
const { movementView, walletView, transferView, userView } = require('../serializers');
const transfers = require('../services/transfers');
const { getStatement } = require('../services/statement');
const { askStatement } = require('../services/statementQa');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9]{10,15}$/;

function cleanNote(note) {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string' || note.length > 280) throw new AppError(400, 'INVALID_NOTE', 'note must be a string of at most 280 characters.');
  return note;
}

async function loadWallet(db, walletId) {
  const { rows } = await db.query(`SELECT * FROM accounts WHERE id = $1 AND kind = 'user_wallet'`, [walletId]);
  if (!rows[0]) throw new AppError(404, 'WALLET_NOT_FOUND', `Wallet ${walletId} does not exist.`);
  return rows[0];
}

async function loadOwnWallet(db, walletId, userId) {
  const wallet = await loadWallet(db, walletId);
  if (wallet.user_id !== userId) throw new AppError(403, 'FORBIDDEN', `Wallet ${walletId} does not belong to you.`);
  return wallet;
}

function sameUser(req, userId) {
  if (requireUser(req) !== userId) throw new AppError(403, 'FORBIDDEN', 'You can only act on your own account.');
}

// ---------------------------------------------------------------- users ----

router.post('/users', idempotent(async (client, req) => {
  const { name, email, phone } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new AppError(400, 'INVALID_NAME', 'name is required (max 100 characters).');
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) throw new AppError(400, 'INVALID_EMAIL', 'email is not valid.');
  if (typeof phone !== 'string' || !PHONE_RE.test(phone)) throw new AppError(400, 'INVALID_PHONE', 'phone must be 10-15 digits, optionally starting with +.');

  let user;
  try {
    ({ rows: [user] } = await client.query(
      `INSERT INTO users (name, email, phone) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), email.trim(), phone]
    ));
  } catch (err) {
    if (err.code === '23505') throw new AppError(409, 'USER_EXISTS', 'A user with this email or phone already exists.');
    throw err;
  }
  const { rows: [wallet] } = await client.query(
    `INSERT INTO accounts (kind, user_id, name) VALUES ('user_wallet', $1, 'main') RETURNING *`,
    [user.id]
  );
  return { status: 201, body: { user: userView(user), wallets: [walletView(wallet)] } };
}));

router.get('/users/:userId', async (req, res) => {
  const userId = idParam(req, 'userId');
  sameUser(req, userId);
  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  const { rows: wallets } = await pool.query(`SELECT * FROM accounts WHERE user_id = $1 ORDER BY id`, [userId]);
  res.json({ user: userView(user), wallets: wallets.map(walletView) });
});

router.post('/users/:userId/wallets', idempotent(async (client, req) => {
  const userId = idParam(req, 'userId');
  sameUser(req, userId);
  const name = req.body?.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 50) throw new AppError(400, 'INVALID_NAME', 'name is required (max 50 characters).');
  try {
    const { rows: [wallet] } = await client.query(
      `INSERT INTO accounts (kind, user_id, name) VALUES ('user_wallet', $1, $2) RETURNING *`,
      [userId, name.trim()]
    );
    return { status: 201, body: { wallet: walletView(wallet) } };
  } catch (err) {
    if (err.code === '23505') throw new AppError(409, 'WALLET_EXISTS', `You already have a wallet called "${name.trim()}".`);
    throw err;
  }
}));

router.get('/users/:userId/wallets', async (req, res) => {
  const userId = idParam(req, 'userId');
  sameUser(req, userId);
  const { rows } = await pool.query(`SELECT * FROM accounts WHERE user_id = $1 ORDER BY id`, [userId]);
  res.json({ wallets: rows.map(walletView) });
});

// Milestone 5 Part C: plain-English statement questions.
router.post('/users/:userId/statement/ask', idempotent(async (client, req) => {
  const userId = idParam(req, 'userId');
  sameUser(req, userId);
  const question = req.body?.question;
  if (typeof question !== 'string' || !question.trim() || question.length > 500) {
    throw new AppError(400, 'INVALID_QUESTION', 'question must be a non-empty string of at most 500 characters.');
  }
  const answer = await askStatement(client, req.app.locals.llm, { userId, question: question.trim() });
  return { status: 200, body: answer };
}));

// -------------------------------------------------------------- wallets ----

router.get('/wallets/:walletId', async (req, res) => {
  const wallet = await loadOwnWallet(pool, idParam(req, 'walletId'), requireUser(req));
  res.json({ wallet: walletView(wallet) });
});

router.get('/wallets/:walletId/balance', async (req, res) => {
  const wallet = await loadOwnWallet(pool, idParam(req, 'walletId'), requireUser(req));
  res.json({ wallet_id: wallet.id, balance: wallet.balance, balance_formatted: formatPaise(wallet.balance), currency: wallet.currency });
});

router.get('/wallets/:walletId/statement', async (req, res) => {
  const wallet = await loadOwnWallet(pool, idParam(req, 'walletId'), requireUser(req));
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'INVALID_LIMIT', 'limit must be between 1 and 100.');
  if (!Number.isInteger(offset) || offset < 0) throw new AppError(400, 'INVALID_OFFSET', 'offset must be 0 or more.');
  const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined;
  res.json(await getStatement(pool, wallet.id, { limit, offset, cursor }));
});

router.post('/wallets/:walletId/topup', idempotent(async (client, req) => {
  const userId = requireUser(req);
  const walletId = idParam(req, 'walletId');
  await loadOwnWallet(client, walletId, userId);
  const amount = parseAmount(req.body?.amount);
  const result = await transfers.topUp(client, { walletId, amount, note: cleanNote(req.body?.note), userId });
  return { status: 201, body: movementView(result, walletId) };
}));

router.post('/wallets/:walletId/withdraw', idempotent(async (client, req) => {
  const userId = requireUser(req);
  const walletId = idParam(req, 'walletId');
  await loadOwnWallet(client, walletId, userId);
  const amount = parseAmount(req.body?.amount);
  const result = await transfers.withdraw(client, { walletId, amount, note: cleanNote(req.body?.note), userId });
  return { status: result.held ? 202 : 201, body: movementView(result, walletId) };
}));

// ------------------------------------------------------------ transfers ----

router.post('/transfers', idempotent(async (client, req) => {
  const userId = requireUser(req);
  const body = req.body || {};
  const fromWalletId = Number(body.from_wallet_id);
  const toWalletId = Number(body.to_wallet_id);
  if (!Number.isSafeInteger(fromWalletId) || fromWalletId < 1 || !Number.isSafeInteger(toWalletId) || toWalletId < 1) {
    throw new AppError(400, 'INVALID_WALLET', 'from_wallet_id and to_wallet_id must be wallet ids.');
  }
  await loadOwnWallet(client, fromWalletId, userId);
  await loadWallet(client, toWalletId); // recipient must be a user wallet, never a system account
  const amount = parseAmount(body.amount);
  const result = await transfers.peerTransfer(client, { fromWalletId, toWalletId, amount, note: cleanNote(body.note), userId });
  return { status: result.held ? 202 : 201, body: movementView(result, fromWalletId) };
}));

router.get('/transfers/:transferId', async (req, res) => {
  const transferId = idParam(req, 'transferId');
  const { rows: [t] } = await pool.query(
    `SELECT t.*, s.user_id AS source_user_id, d.user_id AS destination_user_id
       FROM transfers t
       JOIN accounts s ON s.id = t.source_account_id
       JOIN accounts d ON d.id = t.destination_account_id
      WHERE t.id = $1`,
    [transferId]
  );
  if (!t) throw new AppError(404, 'TRANSFER_NOT_FOUND', `Transfer ${transferId} does not exist.`);
  if (!req.admin) {
    const userId = requireUser(req);
    if (t.source_user_id !== userId && t.destination_user_id !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'You are not part of this transfer.');
    }
  }
  const [entries, history, flags] = await Promise.all([
    pool.query('SELECT id, account_id, direction, amount, created_at FROM ledger_entries WHERE transfer_id = $1 ORDER BY id', [transferId]),
    pool.query('SELECT from_status, to_status, changed_by, reason, changed_at FROM transfer_status_history WHERE transfer_id = $1 ORDER BY id', [transferId]),
    pool.query(
      `SELECT r.code AS rule, f.action, f.details, f.llm_label, f.llm_explanation
         FROM risk_flags f JOIN risk_rules r ON r.id = f.rule_id WHERE f.transfer_id = $1 ORDER BY f.id`,
      [transferId]
    ),
  ]);
  res.json({
    transfer: transferView(t),
    ledger_entries: entries.rows,
    status_history: history.rows,
    // risk explanations are for reviewers only
    risk_flags: req.admin ? flags.rows : flags.rows.map(({ rule, action }) => ({ rule, action })),
  });
});

module.exports = router;
