'use strict';

const express = require('express');
const { pool } = require('./db');
const { createLlm } = require('./llm');
const { requestId, identity, notFound, errorHandler } = require('./middleware');

function createApp({ llm } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.llm = llm || createLlm();

  app.use(requestId);
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', llm_provider: app.locals.llm.name });
  });

  app.use(identity);
  app.use(require('./routes/wallets'));
  app.use(require('./routes/admin'));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
