/**
 * Shared Pino logger.
 *
 * Lives in utils (not app.js) so integrations and services can log without
 * importing the Express app — which would create a require cycle
 * (app -> routes -> services -> integrations -> app).
 *
 * REDACT_PATHS enforces CLAUDE.md's non-negotiable: SIP passwords, transfer
 * PINs, and account numbers must never reach the logs.
 */
const pino = require('pino');
const config = require('../config');

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.sip_password',
  'req.body.pin',
  'req.body.account_number',
  'res.body.password',
  '*.sip_password',
  '*.password',
  '*.pin',
];

// Stay robust when config is partially mocked in unit tests, and keep test runs
// quiet + free of the pino-pretty transport worker.
const isTest = process.env.NODE_ENV === 'test';

const logger = pino({
  // Force silent under test for clean output regardless of an inherited LOG_LEVEL.
  level: isTest ? 'silent' : (config.logLevel || 'info'),
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  transport: !isTest && !config.isProduction
    ? { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } }
    : undefined,
});

module.exports = { logger, REDACT_PATHS };
