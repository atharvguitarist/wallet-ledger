'use strict';

// Shared test helpers. Tests run against DATABASE_URL, which MUST point at a
// database whose name ends in "_test" — resetDatabase() drops everything in it.

const crypto = require('crypto');
const { pool } = require('../src/db');
const { migrate } = require('../scripts/migrate');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { MockLlm } = require('../src/llm');

const ADMIN = { 'X-Admin-Token': config.adminToken, 'X-Admin-Id': 'tester' };

async function resetDatabase() {
  const dbName = new URL(config.databaseUrl).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to wipe "${dbName}". Point DATABASE_URL at a database ending in _test.`);
  }
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(config.databaseUrl, { log: () => {} });
}

/** Starts the real Express app on a random port. */
async function startServer({ llm = new MockLlm() } = {}) {
  const app = createApp({ llm });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { app, baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Small HTTP client. Every POST gets a fresh Idempotency-Key unless one is given. */
function client(baseUrl) {
  return async function call(method, path, { body, userId, admin = false, key, headers = {} } = {}) {
    const h = { 'content-type': 'application/json', ...headers };
    if (userId) h['X-User-Id'] = String(userId);
    if (admin) Object.assign(h, ADMIN);
    if (method === 'POST' && key !== null) h['Idempotency-Key'] = key || crypto.randomUUID();
    const res = await fetch(baseUrl + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, body: json, headers: res.headers };
  };
}

let counter = 0;
/** Creates a user (with a 'main' wallet) through the API. */
async function createUser(api, name, { kyc } = {}) {
  counter += 1;
  const unique = `${Date.now()}${counter}${Math.floor(Math.random() * 1000)}`.slice(-10);
  const res = await api('POST', '/users', {
    body: { name, email: `${name.toLowerCase().replace(/\s+/g, '.')}.${unique}@test.dev`, phone: `+91${unique}` },
  });
  if (res.status !== 201) throw new Error(`createUser failed: ${res.text}`);
  const user = res.body.user;
  if (kyc) await api('POST', `/admin/users/${user.id}/kyc`, { admin: true, body: { kyc_status: kyc } });
  return { user, wallet: res.body.wallets[0] };
}

async function topUp(api, userId, walletId, amount) {
  const res = await api('POST', `/wallets/${walletId}/topup`, { userId, body: { amount } });
  if (res.status !== 201) throw new Error(`topUp failed: ${res.text}`);
  return res.body;
}

async function scalar(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return Object.values(rows[0])[0];
}

module.exports = { pool, resetDatabase, startServer, client, createUser, topUp, scalar, ADMIN };
