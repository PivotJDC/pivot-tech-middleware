/**
 * Admin authentication middleware (minimal MVP).
 *
 * Verifies a Bearer admin JWT and, when configured, enforces an IP allowlist.
 *
 * DECISION (for Jim): CLAUDE.md describes admin JWTs as RS256, but the only
 * admin key in the environment is the symmetric ADMIN_JWT_SECRET, so this MVP
 * uses HS256. The IP allowlist is exact-match for now; CIDR matching and an
 * RS256 admin keypair are follow-ups for the full Admin API.
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { errors } = require('./errorHandler');

function verifyAdminToken(raw) {
  return jwt.verify(raw, config.admin.jwtSecret, { algorithms: ['HS256'] });
}

function adminAuth(req, res, next) {
  // IP allowlist first (cheap reject before any crypto).
  const allowlist = config.admin.ipAllowlist;
  if (allowlist.length > 0 && !allowlist.includes(req.ip)) {
    next(errors.forbidden('Admin access is not permitted from this address.'));
    return;
  }

  const header = req.headers.authorization || '';
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) {
    next(errors.unauthorized('Admin authentication required.'));
    return;
  }
  if (!config.admin.jwtSecret) {
    next(errors.unauthorized('Admin authentication is not configured.'));
    return;
  }

  try {
    req.admin = verifyAdminToken(value.trim());
    next();
  } catch (err) {
    req.authError = err.name;
    next(errors.unauthorized('Invalid or expired admin token.'));
  }
}

module.exports = { adminAuth, verifyAdminToken };
