/**
 * Express application factory.
 *
 * createApp() builds and returns a configured Express app WITHOUT binding a port
 * — server.js owns the listen() call, and tests import the app directly into
 * Supertest. Routes and the shared error/auth middleware are mounted here as
 * they are built out; for now the app exposes structured logging, JSON parsing,
 * a /health probe, and the standard 404 + error envelope from CLAUDE.md.
 *
 * The shared Pino logger now lives in src/utils/logger.js (so integrations can
 * log without importing the app); it is re-exported here for server.js.
 */
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const pino = require('pino');
const pinoHttp = require('pino-http');

const config = require('./config');
const db = require('./db');
const { logger, REDACT_PATHS } = require('./utils/logger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const accountsRouter = require('./routes/v1/accounts');
const authRouter = require('./routes/v1/auth');
const didsRouter = require('./routes/v1/dids');
const provisionRouter = require('./routes/v1/provision');
const webhooksRouter = require('./routes/v1/webhooks');
const adminRouter = require('./routes/admin');

// Browser origins always allowed, regardless of environment. Production custom
// domains are added via CORS_ORIGINS (config.cors.origins) without a deploy.
const STATIC_CORS_ORIGINS = [
  'https://pivot-tech-dashboard.netlify.app',
  'http://localhost:3000',
];

// Netlify preview deploys get a per-branch subdomain (e.g.
// deploy-preview-12--pivot-tech-dashboard.netlify.app), so allow any
// *.netlify.app host. Anchored to avoid matching e.g. evil-netlify.app.com.
const NETLIFY_HOST = /^https:\/\/([a-z0-9-]+\.)*netlify\.app$/i;

/** Build the cors options, merging static defaults with CORS_ORIGINS. */
function corsOptions() {
  const allowList = new Set([...STATIC_CORS_ORIGINS, ...config.cors.origins]);
  return {
    origin(origin, callback) {
      // No Origin header → not a browser CORS request (curl, health checks,
      // server-to-server). Allow; there is nothing to protect cross-origin.
      if (!origin) return callback(null, true);
      const allowed = allowList.has(origin) || NETLIFY_HOST.test(origin);
      // On a disallowed origin we resolve false (not an error): cors simply
      // omits the Access-Control-Allow-Origin header and the browser blocks it.
      return callback(null, allowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    maxAge: 86400,
  };
}

function createApp() {
  const app = express();

  // Behind AWS App Runner the real client IP arrives via X-Forwarded-For;
  // trust one proxy hop so rate limiting and the admin IP allowlist see it.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // CORS first, so preflight (OPTIONS) and every response — including 404s and
  // error envelopes — carry the right headers for the browser dashboard.
  app.use(cors(corsOptions()));

  // genReqId produces the `req_...` trace ids surfaced in the error envelope
  // (CLAUDE.md "Error Response Format"); honors an inbound X-Request-Id if set.
  // The req serializer scrubs the provisioning ?token= from the logged URL so
  // single-use tokens never land in logs (CLAUDE.md security rule #1).
  app.use(pinoHttp({
    logger,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    genReqId: (req) => req.headers['x-request-id'] || `req_${crypto.randomUUID()}`,
    serializers: {
      req(req) {
        const serialized = pino.stdSerializers.req(req);
        if (serialized.url) {
          serialized.url = serialized.url.replace(/([?&]token=)[^&]+/i, '$1[REDACTED]');
        }
        return serialized;
      },
    },
  }));
  // Capture the raw body so webhook routes can verify the HMAC signature over
  // the exact bytes SignalWire signed (CLAUDE.md rule #5).
  app.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));

  // Liveness probe for the App Runner health check: answers 200 as long as the
  // process is up and the event loop is serving — no dependency checks, so a
  // database blip never makes App Runner kill/recycle otherwise-healthy
  // instances. Deeper connectivity reporting stays on /health.
  app.get('/ping', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness/diagnostic probe. Reports DB connectivity; returns 503 when the
  // database is unreachable.
  app.get('/health', async (req, res) => {
    try {
      await db.healthCheck();
      res.json({ status: 'ok', env: config.env });
    } catch (err) {
      req.log.error({ err }, 'health check failed: database unreachable');
      res.status(503).json({ status: 'degraded', db: 'unreachable' });
    }
  });

  // Customer API. Further routers (ports, webhooks, admin) mount here as they
  // are built.
  app.use('/v1/auth', authRouter);
  app.use('/v1/accounts', accountsRouter);
  app.use('/v1/numbers', didsRouter);
  app.use('/v1/provision', provisionRouter);
  app.use('/v1/webhooks', webhooksRouter);
  app.use('/admin', adminRouter);

  // 404 + centralized error envelope (CLAUDE.md "Error Response Format").
  // Must be mounted last and in this order.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, logger };
