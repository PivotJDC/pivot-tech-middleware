/**
 * Admin authentication middleware.
 *
 * Enforces, in order:
 *   1. IP allowlist (CIDR-aware for IPv4; exact match otherwise). Enforced in
 *      production only; skipped outside production or when ADMIN_IP_ALLOWLIST
 *      is empty.
 *   2. A Bearer admin JWT (HS256, signed with ADMIN_JWT_SECRET) that carries a
 *      `sub` claim identifying the admin — used for audit logging on actions
 *      like forced status changes.
 *
 * Fails CLOSED: if ADMIN_JWT_SECRET is not configured, every admin request is
 * rejected. On success, req.admin = { id, ...claims }.
 *
 * DECISION (for Jim): CLAUDE.md describes admin JWTs as RS256, but the only
 * admin key in the environment is the symmetric ADMIN_JWT_SECRET, so this uses
 * HS256. IPv6 CIDR matching is a follow-up (IPv6 entries fall back to exact
 * match); the IPv4-mapped form ::ffff:a.b.c.d is normalized.
 */
/* eslint-disable no-bitwise */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { errors } = require('./errorHandler');

/** Parse a dotted IPv4 string to a uint32, or null if not valid IPv4. */
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (let i = 0; i < 4; i += 1) {
    const octet = Number(parts[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

/** True if `ip` matches an allowlist entry (exact, or inside an IPv4 CIDR). */
function matchesEntry(ip, entry) {
  if (!entry.includes('/')) return ip === entry;
  const [range, bitsRaw] = entry.split('/');
  const bits = Number(bitsRaw);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function isIpAllowed(ip, allowlist) {
  // Normalize the IPv4-mapped IPv6 form (e.g. ::ffff:127.0.0.1).
  const normalized = ip && ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  return allowlist.some((entry) => matchesEntry(normalized, entry) || ip === entry);
}

function verifyAdminToken(raw) {
  return jwt.verify(raw, config.admin.jwtSecret, { algorithms: ['HS256'] });
}

function adminAuth(req, res, next) {
  // 1. IP allowlist (cheap reject before any crypto). Enforced in production
  //    only — in development/test the dashboard can be reached from any IP.
  const allowlist = config.admin.ipAllowlist;
  if (config.isProduction && allowlist.length > 0 && !isIpAllowed(req.ip, allowlist)) {
    next(errors.forbidden('Admin access is not permitted from this address.'));
    return;
  }

  // 2. Fail closed if admin auth is not configured.
  if (!config.admin.jwtSecret) {
    next(errors.unauthorized('Admin authentication is not configured.'));
    return;
  }

  const header = req.headers.authorization || '';
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) {
    next(errors.unauthorized('Admin authentication required.'));
    return;
  }

  let claims;
  try {
    claims = verifyAdminToken(value.trim());
  } catch (err) {
    req.authError = err.name;
    next(errors.unauthorized('Invalid or expired admin token.'));
    return;
  }

  if (!claims.sub) {
    next(errors.unauthorized('Admin token is missing a subject (admin identity).'));
    return;
  }

  req.admin = { id: claims.sub, ...claims };
  next();
}

/**
 * Gate a route on the admin's role. Use AFTER adminAuth (which populates
 * req.admin from the JWT's `role` claim). Tokens without a matching role —
 * including legacy tokens that carry no role at all — are rejected 403.
 *   router.post('/users', requireRole('super_admin'), handler)
 * @param {...string} allowedRoles
 */
function requireRole(...allowedRoles) {
  return function roleGuard(req, res, next) {
    const role = req.admin && req.admin.role;
    if (!role || !allowedRoles.includes(role)) {
      next(errors.forbidden('Your role does not permit this action.'));
      return;
    }
    next();
  };
}

module.exports = {
  adminAuth, requireRole, verifyAdminToken, isIpAllowed,
};
