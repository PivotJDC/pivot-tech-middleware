/**
 * Token primitives.
 *
 *  1. Provisioning tokens — single-use secrets handed to a customer in the
 *     Acrobits QR / deep link. Only a SHA-256 hash is ever stored
 *     (provisioning_tokens.token_hash); the raw value lives only in the link.
 *
 *  2. Customer JWTs — RS256 (CLAUDE.md API surface). Signed with the private
 *     key (config.jwt.signingKey), verified with the public key
 *     (config.jwt.publicKey). 24h TTL.
 *
 * Admin JWTs are intentionally NOT here — they live with adminAuth.js, built
 * alongside the admin API later.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const PROVISIONING_TOKEN_BYTES = 32;

/** Generate a fresh, URL-safe provisioning token (the raw secret). */
function generateProvisioningToken() {
  return crypto.randomBytes(PROVISIONING_TOKEN_BYTES).toString('base64url');
}

/** Hash a provisioning token for storage / lookup. Stable SHA-256 hex. */
function hashProvisioningToken(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new TypeError('provisioning token must be a non-empty string');
  }
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Sign a customer JWT (RS256).
 * @param {{ sub: string, [key: string]: any }} payload - must include `sub`
 *   (the account id). Any extra claims are passed through.
 * @param {{ expiresIn?: string|number }} [opts]
 */
function signCustomerToken(payload, opts = {}) {
  if (!config.jwt.signingKey) {
    throw new Error('JWT signing key (JWT_SECRET) is not configured');
  }
  if (!payload || !payload.sub) {
    throw new TypeError('customer token payload requires a `sub` (account id)');
  }
  return jwt.sign(payload, config.jwt.signingKey, {
    algorithm: 'RS256',
    expiresIn: opts.expiresIn || config.jwt.customerTtl,
  });
}

/**
 * Verify a customer JWT. Returns the decoded payload, or throws the underlying
 * jsonwebtoken error (TokenExpiredError / JsonWebTokenError) so callers can
 * distinguish expiry from a malformed/forged token.
 */
function verifyCustomerToken(token) {
  if (!config.jwt.publicKey) {
    throw new Error('JWT public key (JWT_PUBLIC_KEY) is not configured');
  }
  return jwt.verify(token, config.jwt.publicKey, { algorithms: ['RS256'] });
}

module.exports = {
  generateProvisioningToken,
  hashProvisioningToken,
  signCustomerToken,
  verifyCustomerToken,
};
