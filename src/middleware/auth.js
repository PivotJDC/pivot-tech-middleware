/**
 * Customer authentication middleware.
 *
 * `authenticate` extracts a Bearer token, verifies it as an RS256 customer JWT
 * (via utils/token), and attaches { accountId, claims } to req.auth. Any failure
 * — missing header, malformed/forged token, or expiry — yields UNAUTHORIZED.
 *
 * Note: per CLAUDE.md the TOKEN_EXPIRED code is reserved for *provisioning*
 * tokens; an expired JWT is surfaced as UNAUTHORIZED ("invalid token").
 *
 * `requireSelf` enforces that the authenticated account matches the :id in the
 * route — a customer may only act on their own account. Cross-account access is
 * FORBIDDEN (valid token, insufficient scope).
 */
const token = require('../utils/token');
const { errors } = require('./errorHandler');

function bearerFrom(req) {
  const header = req.headers.authorization || '';
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) return null;
  return value.trim();
}

function authenticate(req, res, next) {
  const raw = bearerFrom(req);
  if (!raw) {
    next(errors.unauthorized('Missing or malformed Authorization header.'));
    return;
  }

  try {
    const claims = token.verifyCustomerToken(raw);
    req.auth = { accountId: claims.sub, claims };
    next();
  } catch (err) {
    // Expired and forged tokens both collapse to UNAUTHORIZED here; the log
    // (via errorHandler) retains the underlying reason for diagnostics.
    req.authError = err.name;
    next(errors.unauthorized('Invalid or expired token.'));
  }
}

/** Guard a route so the caller may only touch their own account (req.params.id). */
function requireSelf(req, res, next) {
  if (!req.auth || !req.auth.accountId) {
    next(errors.unauthorized('Authentication required.'));
    return;
  }
  if (req.auth.accountId !== req.params.id) {
    next(errors.forbidden('You may only access your own account.'));
    return;
  }
  next();
}

module.exports = { authenticate, requireSelf };
