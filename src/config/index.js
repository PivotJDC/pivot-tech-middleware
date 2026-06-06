/**
 * Centralized configuration: loads, validates, and freezes environment config.
 *
 * In development the values come from a local .env file (loaded here via dotenv).
 * In production, secrets are injected from AWS Secrets Manager into the process
 * environment by the runtime — never read from a committed .env file
 * (see CLAUDE.md "Security Rules"). This module only reads process.env; it does
 * not call Secrets Manager directly.
 *
 * Validation is fail-fast: if any required key for the current NODE_ENV is
 * missing, the process throws at import time with the full list of what's
 * missing, so a misconfigured deploy never starts half-initialized.
 */
const path = require('path');

const NODE_ENV = process.env.NODE_ENV || 'development';

// Load .env for local/test runs only. Production relies on injected env vars.
if (NODE_ENV !== 'production') {
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
}

// Keys that must always be present for the app to boot.
const REQUIRED_ALWAYS = ['DATABASE_URL'];

// Keys additionally required when running in production. Locally these can be
// absent so a developer can boot the core app before every vendor is wired up.
const REQUIRED_IN_PRODUCTION = [
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_PUBLIC_KEY',
  'ADMIN_JWT_SECRET',
  'ENCRYPTION_KEY',
  'SIGNALWIRE_SPACE',
  'SIGNALWIRE_PROJECT_ID',
  'SIGNALWIRE_API_TOKEN',
  'SIGNALWIRE_WEBHOOK_SECRET',
  'PROVISIONING_BASE_URL',
];

function requiredKeys() {
  return NODE_ENV === 'production'
    ? [...REQUIRED_ALWAYS, ...REQUIRED_IN_PRODUCTION]
    : REQUIRED_ALWAYS;
}

function validate() {
  const missing = requiredKeys().filter((key) => {
    const value = process.env[key];
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s) for NODE_ENV=${NODE_ENV}: ${missing.join(', ')}`,
    );
  }
}

/**
 * Unescape PEM key material injected via environment variables. Secrets
 * Manager → App Runner env injection delivers multi-line PEM keys as a single
 * line with literal "\n" two-character sequences; jsonwebtoken/crypto need
 * real newlines or RS256 sign/verify fails with a cryptic key-parse error.
 * Safe on already-correct values (nothing to replace).
 */
function unescapePem(value) {
  return (value || '').replace(/\\n/g, '\n');
}

/** Parse a comma-separated env var into a trimmed, non-empty string array. */
function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Parse an integer env var, falling back to a default when unset/invalid. */
function parseIntOr(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function buildConfig() {
  return Object.freeze({
    env: NODE_ENV,
    isProduction: NODE_ENV === 'production',
    isTest: NODE_ENV === 'test',
    port: parseIntOr(process.env.PORT, 3000),
    logLevel: process.env.LOG_LEVEL || 'info',

    database: Object.freeze({
      url: process.env.DATABASE_URL,
    }),

    redis: Object.freeze({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    }),

    jwt: Object.freeze({
    // RS256: JWT_SECRET holds the signing (private) key, JWT_PUBLIC_KEY verifies.
      signingKey: unescapePem(process.env.JWT_SECRET),
      publicKey: unescapePem(process.env.JWT_PUBLIC_KEY),
      customerTtl: '24h',
    }),

    admin: Object.freeze({
      jwtSecret: process.env.ADMIN_JWT_SECRET || '',
      ipAllowlist: Object.freeze(parseList(process.env.ADMIN_IP_ALLOWLIST)),
      jwtTtl: '8h',
    }),

    encryptionKey: process.env.ENCRYPTION_KEY || '',

    signalwire: Object.freeze({
      space: process.env.SIGNALWIRE_SPACE || '',
      projectId: process.env.SIGNALWIRE_PROJECT_ID || '',
      apiToken: process.env.SIGNALWIRE_API_TOKEN || '',
      webhookSecret: process.env.SIGNALWIRE_WEBHOOK_SECRET || '',
    }),

    aws: Object.freeze({
      region: process.env.AWS_REGION || 'us-east-1',
      sqs: Object.freeze({
        didAssignmentQueueUrl: process.env.SQS_DID_ASSIGNMENT_QUEUE_URL || '',
        notificationQueueUrl: process.env.SQS_NOTIFICATION_QUEUE_URL || '',
      }),
    }),

    apns: Object.freeze({
      keyId: process.env.APNS_KEY_ID || '',
      teamId: process.env.APNS_TEAM_ID || '',
      bundleId: process.env.APNS_BUNDLE_ID || 'io.pivot-tech.dialer',
      // DECISION: APNS/FCM private keys are PEM too — same Secrets Manager
      // literal-\n injection issue as the JWT keys, so unescape them the same
      // way. ADMIN_JWT_SECRET is deliberately NOT unescaped: it is an HS256
      // shared secret, not PEM, and must be used byte-for-byte as provided.
      privateKey: unescapePem(process.env.APNS_PRIVATE_KEY),
    }),

    fcm: Object.freeze({
      projectId: process.env.FCM_PROJECT_ID || '',
      privateKey: unescapePem(process.env.FCM_PRIVATE_KEY),
      clientEmail: process.env.FCM_CLIENT_EMAIL || '',
    }),

    provisioning: Object.freeze({
      baseUrl: process.env.PROVISIONING_BASE_URL || 'https://api.pivot-tech.io',
      tokenTtlHours: parseIntOr(process.env.PROVISIONING_TOKEN_TTL_HOURS, 72),
    }),
  });
}

// Initialization is wrapped so a config failure (most commonly validate()
// throwing on missing env vars) always lands in the logs. This runs at require
// time — before Pino exists — so console.error is the only safe sink; App
// Runner forwards it to the CloudWatch application log group. Rethrow so the
// process still fails fast (server.js logs its own structured line and exits).
let config;
try {
  validate();
  config = buildConfig();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`FATAL: configuration failed to initialize: ${err.message}\n${err.stack}`);
  throw err;
}

module.exports = config;
