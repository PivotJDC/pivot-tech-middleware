/**
 * Express application factory.
 *
 * createApp() builds and returns a configured Express app WITHOUT binding a port
 * — server.js owns the listen() call, and tests import the app directly into
 * Supertest. Routes and the shared error/auth middleware are mounted here as
 * they are built out; for now the app exposes structured logging, JSON parsing,
 * a /health probe, and the standard 404 + error envelope from CLAUDE.md.
 *
 * DECISION (for Jim): the base Pino logger lives here for now and is exported
 * alongside createApp so server.js can reuse it. When we add the logging
 * middleware layer it will move to src/utils/logger.js with the sanitizeLog
 * redaction rules; the redact paths below are the seed for that.
 */
const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const config = require('./config');
const db = require('./db');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const accountsRouter = require('./routes/v1/accounts');

// Redaction guards CLAUDE.md's non-negotiable: SIP passwords, transfer PINs,
// and account numbers must never reach the logs. Paths cover both request
// bodies and known sensitive headers.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.sip_password',
  'req.body.pin',
  'req.body.account_number',
  'res.body.password',
];

const logger = pino({
  level: config.logLevel,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  // Pretty-print locally; emit raw JSON lines in production for log ingestion.
  transport: config.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } },
});

function createApp() {
  const app = express();

  // Behind AWS App Runner the real client IP arrives via X-Forwarded-For;
  // trust one proxy hop so rate limiting and the admin IP allowlist see it.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // genReqId produces the `req_...` trace ids surfaced in the error envelope
  // (CLAUDE.md "Error Response Format"); honors an inbound X-Request-Id if set.
  app.use(pinoHttp({
    logger,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    genReqId: (req) => req.headers['x-request-id'] || `req_${crypto.randomUUID()}`,
  }));
  app.use(express.json({ limit: '1mb' }));

  // Liveness + readiness probe. Reports DB connectivity; returns 503 when the
  // database is unreachable so App Runner can pull the instance out of service.
  app.get('/health', async (req, res) => {
    try {
      await db.healthCheck();
      res.json({ status: 'ok', env: config.env });
    } catch (err) {
      req.log.error({ err }, 'health check failed: database unreachable');
      res.status(503).json({ status: 'degraded', db: 'unreachable' });
    }
  });

  // Customer API. Further routers (provision, ports, webhooks, admin) mount
  // here as they are built.
  app.use('/v1/accounts', accountsRouter);

  // 404 + centralized error envelope (CLAUDE.md "Error Response Format").
  // Must be mounted last and in this order.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, logger };
