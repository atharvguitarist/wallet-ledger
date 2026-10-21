'use strict';

const { pool } = require('./db');
const { runReconciliation } = require('./services/reconciliation');
const { explainFlags } = require('./services/flagExplainer');

/** Optional cleanup from Milestone 3: forget idempotency keys older than 24 hours. */
async function cleanupIdempotencyKeys() {
  const { rowCount } = await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  return { deleted: rowCount };
}

/** Everything the worker does each night, in order. */
async function runNightly(llm, { triggeredBy = 'scheduler' } = {}) {
  const reconciliation = await runReconciliation({ triggeredBy });
  const flags = await explainFlags(llm);
  const cleanup = await cleanupIdempotencyKeys();
  return {
    reconciliation: reconciliation.skipped
      ? { skipped: true, reason: reconciliation.reason }
      : { run_id: reconciliation.run.id, status: reconciliation.run.status, problems: reconciliation.run.problem_count },
    flag_explanations: flags,
    idempotency_cleanup: cleanup,
  };
}

module.exports = { runNightly, cleanupIdempotencyKeys };
