'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { pool } = require('./db');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} (LLM provider: ${app.locals.llm.name})`);
});

function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
