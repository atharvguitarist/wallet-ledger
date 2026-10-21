'use strict';

const express = require('express');
const { pool, setActor } = require('../db');
const { AppError } = require('../errors');
const { idempotent } = require('../idempotency');
const { requireAdmin, idParam } = require('../middleware');
const { movementView, transferView, userView } = require('../serializers');
const transfers = require('../services/transfers');
const { runReconciliation, getRun } = require('../services/reconciliation');
const { explainFlags } = require('../services/flagExplainer');

const router = express.Router();
router.use('/admin', requireAdmin);

function reasonFrom(req) {
  const reason = req.body?.reason;
  if (reason === undefined || reason === null) return '';
  if (typeof reason !== 'string' || reason.length > 280) throw new AppError(400, 'INVALID_REASON', 'reason must be a string of at most 280 characters.');
  return reason;
}

// Review queue
router.get('/admin/transfers', async (req, res) => {
  const status = req.query.status || 'held';
  if (!['held', 'completed', 'rejected', 'reversed'].includes(status)) throw new AppError(400, 'INVALID_STATUS', 'Unknown status filter.');
  const { rows } = await pool.query(
    `SELECT t.*, COALESCE(json_agg(json_build_object('rule', r.code, 'action', f.action, 'label', f.llm_label))
                          FILTER (WHERE f.id IS NOT NULL), '[]') AS flags
       FROM transfers t
       LEFT JOIN risk_flags f ON f.transfer_id = t.id
       LEFT JOIN risk_rules r ON r.id = f.rule_id
      WHERE t.status = $1
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT 100`,
    [status]
  );
  res.json({ transfers: rows.map((t) => transferView(t, { risk_flags: t.flags })) });
});

router.post('/admin/transfers/:transferId/release', idempotent(async (client, req) => {
  await setActor(client, `admin:${req.admin}`, reasonFrom(req) || 'released after review');
  const result = await transfers.releaseHeld(client, idParam(req, 'transferId'));
  return { status: 200, body: movementView(result, result.transfer.source_account_id) };
}));

router.post('/admin/transfers/:transferId/reject', idempotent(async (client, req) => {
  await setActor(client, `admin:${req.admin}`, reasonFrom(req) || 'rejected after review');
  const { transfer } = await transfers.rejectHeld(client, idParam(req, 'transferId'));
  return { status: 200, body: { transfer: transferView(transfer), message: 'Rejected. No money moved.' } };
}));

router.post('/admin/transfers/:transferId/reverse', idempotent(async (client, req) => {
  const reason = reasonFrom(req);
  await setActor(client, `admin:${req.admin}`, reason || 'reversed');
  const result = await transfers.reverse(client, idParam(req, 'transferId'), { note: reason || undefined });
  return { status: 201, body: { reversal: movementView(result).transfer, original_transfer_id: result.transfer.related_transfer_id } };
}));

router.post('/admin/users/:userId/kyc', idempotent(async (client, req) => {
  const status = req.body?.kyc_status;
  if (!['pending', 'verified', 'rejected'].includes(status)) throw new AppError(400, 'INVALID_KYC_STATUS', 'kyc_status must be pending, verified or rejected.');
  const { rows: [user] } = await client.query(
    'UPDATE users SET kyc_status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [idParam(req, 'userId'), status]
  );
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  return { status: 200, body: { user: userView(user) } };
}));

// Manual reconciliation run (the worker runs the same function every night).
router.post('/admin/reconciliation/run', idempotent(async (client, req) => {
  const result = await runReconciliation({ triggeredBy: `admin:${req.admin}` });
  if (result.skipped) throw new AppError(409, 'RECONCILIATION_RUNNING', result.reason);
  return { status: 200, body: await getRun(pool, result.run.id) };
}));

router.get('/admin/reconciliation/runs', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 20');
  res.json({ runs: rows });
});

router.get('/admin/reconciliation/runs/:runId', async (req, res) => {
  const run = await getRun(pool, idParam(req, 'runId'));
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', 'Reconciliation run not found.');
  res.json(run);
});

// Manual trigger for the nightly LLM explanation step.
router.post('/admin/risk/explain', idempotent(async (client, req) => {
  const counts = await explainFlags(req.app.locals.llm);
  return { status: 200, body: { ...counts, llm_provider: req.app.locals.llm.name } };
}));

router.get('/admin/risk-flags', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.transfer_id, r.code AS rule, f.action, f.details, f.llm_label, f.llm_explanation,
            f.llm_provider, f.explained_at, f.created_at
       FROM risk_flags f JOIN risk_rules r ON r.id = f.rule_id
      ORDER BY f.id DESC LIMIT 100`
  );
  res.json({ risk_flags: rows });
});

router.get('/admin/risk-rules', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM risk_rules ORDER BY id');
  res.json({ risk_rules: rows });
});

module.exports = router;
