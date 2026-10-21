'use strict';

const env = process.env;

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

module.exports = {
  port: int('PORT', 3000),
  // Default matches docker-compose (Postgres published on host port 5433).
  databaseUrl: env.DATABASE_URL || 'postgres://wallet:wallet@localhost:5433/wallet',
  pgPoolMax: int('PG_POOL_MAX', 20),

  // Simulated auth. Real auth (JWT/OAuth) is out of scope for this project.
  adminToken: env.ADMIN_TOKEN || 'dev-admin-token',

  // Flat fee on every withdrawal, in paise (₹2 by default). 0 disables fees.
  withdrawalFeePaise: int('WITHDRAWAL_FEE_PAISE', 200),

  timezone: 'Asia/Kolkata',
  reconCron: env.RECON_CRON || '30 2 * * *', // 02:30 IST every night
  runJobsOnStart: env.RUN_JOBS_ON_START === 'true',

  llm: {
    provider: (env.LLM_PROVIDER || '').toLowerCase(), // mock | anthropic | openai ('' = auto)
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    openaiApiKey: env.OPENAI_API_KEY || '',
    openaiBaseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: env.LLM_MODEL || '',
    timeoutMs: int('LLM_TIMEOUT_MS', 15000),
  },
};
