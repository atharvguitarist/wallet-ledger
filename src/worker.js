'use strict';

// Background worker: runs the nightly job on a cron schedule (02:30 IST by default).
//   1. reconciliation  2. LLM explanations for new risk flags  3. idempotency-key cleanup
// Set RUN_JOBS_ON_START=true to also run it once when the worker boots (handy for demos).

const cron = require('node-cron');
const config = require('./config');
const { createLlm } = require('./llm');
const { runNightly } = require('./jobs');
const { pool } = require('./db');

const llm = createLlm();
let running = false;

async function tick(triggeredBy) {
  if (running) return console.log('[worker] previous run still going, skipping this tick');
  running = true;
  const started = Date.now();
  try {
    const result = await runNightly(llm, { triggeredBy });
    console.log(`[worker] nightly job done in ${Date.now() - started} ms`, JSON.stringify(result));
  } catch (err) {
    console.error('[worker] nightly job failed:', err.message);
  } finally {
    running = false;
  }
}

cron.schedule(config.reconCron, () => tick('scheduler'), { timezone: config.timezone });
console.log(`[worker] scheduled nightly job "${config.reconCron}" (${config.timezone}); LLM provider: ${llm.name}`);
if (config.runJobsOnStart) tick('worker-start');

process.on('SIGTERM', () => pool.end().then(() => process.exit(0)));
process.on('SIGINT', () => pool.end().then(() => process.exit(0)));
