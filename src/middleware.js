'use strict';

const crypto = require('crypto');
const config = require('./config');
const { pool } = require('./db');
const { AppError, errorBody } = require('./errors');

function requestId(req, res, next) {
  req.requestId = req.get('X-Request-Id') || crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
}

/*
 * Simulated authentication (real login is out of scope for this project):
 *   X-User-Id: 42                 -> you are user 42
 *   X-Admin-Token: <ADMIN_TOKEN>  -> you are an admin (X-Admin-Id names you in the audit log)
 */
async function identity(req, res, next) {
  const rawUser = req.get('X-User-Id');
  if (rawUser !== undefined) {
    if (!/^[1-9][0-9]{0,17}$/.test(rawUser)) throw new AppError(401, 'UNAUTHENTICATED', 'X-User-Id must be a user id.');
    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [rawUser]);
    if (!rows[0]) throw new AppError(401, 'UNAUTHENTICATED', `User ${rawUser} does not exist.`);
    req.callerUserId = rows[0].id;
  }
  const token = req.get('X-Admin-Token');
  if (token !== undefined) {
    const a = Buffer.from(token);
    const b = Buffer.from(config.adminToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid admin token.');
    }
    req.admin = (req.get('X-Admin-Id') || 'admin').slice(0, 64);
  }
  next();
}

function requireUser(req) {
  if (!req.callerUserId) throw new AppError(401, 'UNAUTHENTICATED', 'Send X-User-Id to identify yourself.');
  return req.callerUserId;
}

function requireAdmin(req, res, next) {
  if (!req.admin) throw new AppError(403, 'FORBIDDEN', 'Admin endpoints need a valid X-Admin-Token header.');
  next();
}

/** Path params like :walletId must be positive integers. */
function idParam(req, name) {
  const raw = req.params[name];
  if (!/^[1-9][0-9]{0,17}$/.test(raw)) throw new AppError(400, 'INVALID_ID', `${name} must be a positive integer.`);
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw new AppError(400, 'INVALID_ID', `${name} is too large.`);
  return id;
}

function notFound(req, res) {
  res.status(404).json(errorBody('NOT_FOUND', `No route for ${req.method} ${req.path}`, req.requestId));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json(errorBody(err.code, err.message, req.requestId));
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json(errorBody('INVALID_JSON', 'Request body is not valid JSON.', req.requestId));
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json(errorBody('BODY_TOO_LARGE', 'Request body is too large.', req.requestId));
  }
  console.error(`[${req.requestId}] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json(errorBody('INTERNAL_ERROR', 'Something went wrong. It is safe to retry with the same Idempotency-Key.', req.requestId));
}

module.exports = { requestId, identity, requireUser, requireAdmin, idParam, notFound, errorHandler };
