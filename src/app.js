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

  // Routes mount here as they are built:
  //   app.use('/v1', require('./routes/v1'));
  //   app.use('/admin', require('./routes/admin'));

  // 404 — no route matched.
  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${req.method} ${req.path}.`,
        trace_id: req.id,
      },
    });
  });

  // Centralized error envelope. A thrown error may carry a `.code`, `.status`,
  // and `.field`; otherwise it is treated as an unexpected 500. The internal
  // message is logged but never leaked to the client on a 500.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
    }
    res.status(status).json({
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: status >= 500 ? 'An unexpected error occurred.' : err.message,
        ...(err.field ? { field: err.field } : {}),
        trace_id: req.id,
      },
    });
  });

  return app;
}

module.exports = { createApp, logger };
