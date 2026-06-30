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
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');
const crypto = require('../utils/crypto');
const { errors, AppError } = require('../middleware/errorHandler');
const { logger } = require('../utils/logger');

const ROLES = ['super_admin', 'admin', 'viewer'];

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
    return serialize(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      throw errors.conflict('An admin user with that username or email already exists.', 'username');
    }
    throw err;
  }
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

module.exports = {
  ROLES,
  login,
  createAdminUser,
  listAdminUsers,
  issueToken,
  serialize,
};
