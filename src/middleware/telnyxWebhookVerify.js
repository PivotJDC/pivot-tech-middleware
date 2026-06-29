/**
 * Telnyx webhook Ed25519 signature verification (CLAUDE.md rule #5 — every
 * inbound webhook is validated before processing; hard 403 on failure).
 *
 * Telnyx signs each webhook with Ed25519 and sends two headers:
 *   - telnyx-signature-ed25519 : base64 signature (64 raw bytes)
 *   - telnyx-timestamp         : unix seconds, also part of the signed payload
 * The signed message is `${timestamp}|${rawBody}` (confirmed against the
 * official telnyx-node SDK). The public key is the base64 raw 32-byte Ed25519
 * key from Mission Control / GET /v2/public_key.
 *
 * Raw body: the exact bytes Telnyx signed are captured as req.rawBody by the
 * body-parser `verify` hooks in app.js (both express.json and express.urlencoded)
 * — a JSON re-stringify would not byte-match the signature.
 *
 * Backward compatibility: when no public key is configured/available
 * (telnyx.getWebhookPublicKey() returns ''), verification is skipped so dev and
 * pre-key deployments keep working. Set TELNYX_WEBHOOK_PUBLIC_KEY to enforce.
 *
 * DECISION (GET webhooks): Telnyx's documented/SDK scheme signs the POST body.
 * Our voice (TeXML) webhook can be invoked as GET with query params and no body;
 * for that case we sign `${timestamp}|${fullURL}` (the user-specified GET
 * format). Marked as a decision: validate against a live Telnyx GET webhook
 * before relying on it — until then it stays inert unless a public key is set.
 */
const crypto = require('crypto');
const telnyx = require('../integrations/telnyx');
const { errors } = require('./errorHandler');
const { logger } = require('../utils/logger');

// SubjectPublicKeyInfo (SPKI) DER prefix for an Ed25519 key. Prepending this to
// the raw 32-byte key lets crypto.createPublicKey() build a KeyObject from the
// bare key Telnyx publishes (it ships the raw key, not a PEM/DER wrapper).
const ED25519_SPKI_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Build an Ed25519 public KeyObject from a base64 raw 32-byte key. */
function publicKeyFromBase64(base64Key) {
  const raw = Buffer.from(base64Key, 'base64');
  if (raw.length !== 32) {
    throw new Error(`invalid Ed25519 public key length: ${raw.length} (expected 32)`);
  }
  const der = Buffer.concat([ED25519_SPKI_DER_PREFIX, raw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Verify a base64 Ed25519 signature over `message` with a base64 public key.
 * NB: for EdDSA keys Node requires the algorithm argument to be null — passing
 * 'ed25519' throws "Invalid digest". The key type selects the EdDSA scheme.
 * Returns false (never throws) on any malformed input.
 */
function verifyEd25519(base64Key, base64Signature, message) {
  try {
    const keyObject = publicKeyFromBase64(base64Key);
    const signature = Buffer.from(base64Signature, 'base64');
    if (signature.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message, 'utf8'), keyObject, signature);
  } catch (err) {
    return false;
  }
}

/** The exact message Telnyx signed: timestamp|body (POST) or timestamp|URL (GET). */
function signedMessage(req, timestamp) {
  if (req.method === 'GET') {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return `${timestamp}|${fullUrl}`;
  }
  const body = req.rawBody ? req.rawBody.toString('utf8') : '';
  return `${timestamp}|${body}`;
}

/**
 * Express middleware: verify the Telnyx Ed25519 webhook signature. Skips when no
 * public key is available; otherwise rejects 403 on a missing or invalid
 * signature before the route handler runs.
 */
async function verifyTelnyxWebhook(req, res, next) {
  let publicKey;
  try {
    publicKey = await telnyx.getWebhookPublicKey();
  } catch (err) {
    publicKey = '';
  }

  // No key configured/available → skip (dev / pre-key deployments).
  if (!publicKey) {
    next();
    return;
  }

  const signature = req.headers['telnyx-signature-ed25519'];
  const timestamp = req.headers['telnyx-timestamp'];
  if (!signature || !timestamp) {
    logger.warn({ path: req.path }, 'rejected Telnyx webhook: missing signature headers');
    next(errors.forbidden('Invalid webhook signature.'));
    return;
  }

  if (!verifyEd25519(publicKey, signature, signedMessage(req, timestamp))) {
    logger.warn({ path: req.path }, 'rejected Telnyx webhook: invalid signature');
    next(errors.forbidden('Invalid webhook signature.'));
    return;
  }

  next();
}

module.exports = { verifyTelnyxWebhook };
