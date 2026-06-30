/**
 * Admin user service — accounts that sign in to the ops console.
 *
 * Passwords are bcrypt-hashed (utils/crypto) and never returned. Login issues a
 * short-lived HS256 JWT signed with ADMIN_JWT_SECRET carrying { sub: username,
 * role }, which adminAuth verifies on every admin request and requireRole reads
 * for privileged endpoints.
 *
 * Security: password_hash never leaves this module — serialize() strips it, and
 * login() reveals nothing about which of username/password was wrong (returns
 * null for any failure so the route can answer a single generic 401).
 */
const nodeCrypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');
const cache = require('../cache');
const crypto = require('../utils/crypto');
const emailClient = require('../integrations/email');
const emailTemplates = require('./emailTemplates');
const { errors, AppError } = require('../middleware/errorHandler');
const { logger } = require('../utils/logger');

const ROLES = ['super_admin', 'admin', 'viewer'];
const RESET_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const ADMIN_LOGIN_URL = 'https://mymobilitynet.io/admin';

function resetKey(token) {
  return `admin:reset:${token}`;
}

/** Strip password_hash from a row before it leaves the service. */
function serialize(row) {
  if (!row) return row;
  // eslint-disable-next-line camelcase, no-unused-vars
  const { password_hash, ...safe } = row;
  return safe;
}

/** Sign an 8h HS256 admin JWT for a user. Throws if the secret is unset. */
function issueToken(user) {
  if (!config.admin.jwtSecret) {
    throw new AppError('INTERNAL_ERROR', 'Admin authentication is not configured.');
  }
  return jwt.sign(
    { sub: user.username, role: user.role },
    config.admin.jwtSecret,
    { algorithm: 'HS256', expiresIn: config.admin.jwtTtl },
  );
}

/**
 * Validate credentials and, on success, issue a token + stamp last_login_at.
 * @returns {Promise<{ token, username, role } | null>} null on any failure.
 */
async function login(username, password) {
  if (!username || !password) return null;

  const { rows } = await db.query(
    'SELECT * FROM admin_users WHERE username = $1',
    [username],
  );
  const user = rows[0];
  // Compare even when the user is missing? bcrypt needs a hash; a missing user
  // returns null quickly. The timing difference is acceptable for an
  // IP-rate-limited admin login at MVP scale.
  if (!user) return null;

  const ok = await crypto.verifyPassword(password, user.password_hash);
  if (!ok) return null;

  await db.query(
    'UPDATE admin_users SET last_login_at = NOW() WHERE id = $1',
    [user.id],
  );
  logger.info({ adminUserId: user.id, username: user.username }, 'admin login');

  return { token: issueToken(user), username: user.username, role: user.role };
}

/**
 * Create an admin user. Validates input, hashes the password, inserts, and
 * returns the row without password_hash. Maps a unique-violation to a 409.
 * @param {{ username, email, password, role? }} input
 */
async function createAdminUser(input = {}) {
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const { password } = input;
  const role = input.role || 'admin';

  if (!username) throw errors.validation('username is required.', 'username');
  if (!email) throw errors.validation('email is required.', 'email');
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw errors.validation('password must be at least 8 characters.', 'password');
  }
  if (!ROLES.includes(role)) {
    throw errors.validation(`role must be one of: ${ROLES.join(', ')}.`, 'role');
  }

  const passwordHash = await crypto.hashPassword(password);

  try {
    const { rows } = await db.query(
      `INSERT INTO admin_users (username, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, role, created_at, last_login_at`,
      [username, email, passwordHash, role],
    );
    logger.info({ username, role }, 'admin user created');

    // Best-effort invite email with the plaintext temporary password. Never let
    // an email failure undo or block the (already committed) user creation.
    try {
      const tpl = emailTemplates.adminInvite({ username, password, loginUrl: ADMIN_LOGIN_URL });
      await emailClient.sendEmail({
        to: email, subject: tpl.subject, textBody: tpl.text, htmlBody: tpl.html,
      });
    } catch (err) {
      logger.error({ err: err.message, username }, 'failed to send admin invite email');
    }

    return serialize(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      throw errors.conflict('An admin user with that username or email already exists.', 'username');
    }
    throw err;
  }
}

/** Count existing admin users (used by the one-time bootstrap route). */
async function countAdminUsers() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS total FROM admin_users');
  return rows[0].total;
}

/** List all admin users (never includes password_hash). */
async function listAdminUsers() {
  const { rows } = await db.query(
    `SELECT id, username, email, role, created_at, last_login_at
       FROM admin_users
       ORDER BY created_at`,
  );
  return rows;
}

/** Fetch one admin user by username (no password_hash), or null. */
async function getByUsername(username) {
  const { rows } = await db.query(
    `SELECT id, username, email, role, created_at, last_login_at
       FROM admin_users WHERE username = $1`,
    [username],
  );
  return rows[0] || null;
}

/**
 * Begin a password reset: if an admin user has this email, mint a UUID reset
 * token in Redis (admin:reset:{token} -> username, 15-min TTL) and email the
 * reset link (best-effort). No-op for an unknown email — callers always answer
 * { sent: true } so the endpoint never reveals whether the email exists.
 */
async function requestPasswordReset(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return;
  const { rows } = await db.query('SELECT username FROM admin_users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user) {
    logger.info({ email }, 'admin password reset requested for unknown email (no-op)');
    return;
  }
  const token = nodeCrypto.randomUUID();
  await cache.setWithTtl(resetKey(token), user.username, RESET_TOKEN_TTL_SECONDS);
  logger.info({ username: user.username }, 'admin password reset link generated');

  // Best-effort delivery — never let an email failure surface to the caller.
  try {
    const resetLink = `${ADMIN_LOGIN_URL}/reset-password?token=${token}`;
    const tpl = emailTemplates.adminPasswordReset({ resetLink });
    await emailClient.sendEmail({
      to: email, subject: tpl.subject, textBody: tpl.text, htmlBody: tpl.html,
    });
  } catch (err) {
    logger.error({ err: err.message, username: user.username }, 'failed to send admin reset email');
  }
}

/**
 * Complete a password reset: exchange a valid token for a new password. Returns
 * true on success; returns false when the token is missing/expired/invalid.
 * Throws VALIDATION_ERROR when the new password is too short.
 */
async function resetPassword(token, newPassword) {
  if (!token) return false;
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    throw errors.validation('new_password must be at least 8 characters.', 'new_password');
  }
  const username = await cache.get(resetKey(token));
  if (!username) return false;

  const passwordHash = await crypto.hashPassword(newPassword);
  await db.query('UPDATE admin_users SET password_hash = $1 WHERE username = $2', [passwordHash, username]);
  await cache.del(resetKey(token));
  logger.info({ username }, 'admin password reset completed');
  return true;
}

module.exports = {
  ROLES,
  login,
  createAdminUser,
  countAdminUsers,
  listAdminUsers,
  getByUsername,
  requestPasswordReset,
  resetPassword,
  issueToken,
  serialize,
};
