/**
 * Passwordless customer auth — email + 6-digit verification code.
 *
 * Flow:
 *   1. sendCode(email): if an account exists for the email, generate a 6-digit
 *      code and store it in Redis under auth:code:{email} with a 10-minute TTL.
 *      The code is currently logged (email delivery is a follow-up). To avoid
 *      account enumeration, the route always answers { sent: true } regardless.
 *   2. verifyCode(email, code): on a match, delete the code (single-use) and
 *      return a signed 24h customer JWT (sub = account id) + the serialized
 *      account. Any mismatch / expiry returns null (the route answers 401).
 */
const crypto = require('crypto');
const cache = require('../cache');
const accountService = require('./accountService');
const token = require('../utils/token');
const { logger } = require('../utils/logger');

const CODE_TTL_SECONDS = 10 * 60; // 10 minutes

/** Lowercase + trim so the Redis key is stable across send/verify. */
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function codeKey(email) {
  return `auth:code:${normalizeEmail(email)}`;
}

/** A zero-padded 6-digit code from a CSPRNG. */
function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Look up the primary account by email, returning null instead of throwing. */
async function findAccount(email) {
  try {
    return await accountService.getAccountByEmail(email);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

/**
 * Issue a login code for an email if an account exists. Never reveals whether
 * the email matched — callers always respond { sent: true }.
 */
async function sendCode(rawEmail) {
  const email = normalizeEmail(rawEmail);
  const account = await findAccount(email);
  if (!account) {
    // No account: do nothing (but the caller still answers { sent: true }).
    logger.info({ email }, 'auth code requested for unknown email (no-op)');
    return;
  }

  const code = generateCode();
  await cache.setWithTtl(codeKey(email), code, CODE_TTL_SECONDS);
  // TODO: deliver via email. Until then we log the code for dev/testing — this
  // is an explicit MVP step and must be removed once email delivery lands.
  logger.info({ email, code }, 'auth code generated (email delivery pending)');
}

/**
 * Verify a submitted code. On success: consume the code (single-use) and return
 * { token, account }. On any failure (no code on file, mismatch, unknown
 * account) return null so the route answers a single generic 401.
 */
async function verifyCode(rawEmail, code) {
  const email = normalizeEmail(rawEmail);
  if (!code) return null;

  const stored = await cache.get(codeKey(email));
  if (!stored || String(stored) !== String(code)) return null;

  // Consume the code immediately so it cannot be replayed.
  await cache.del(codeKey(email));

  const account = await findAccount(email);
  if (!account) return null;

  const jwt = token.signCustomerToken({ sub: account.id });
  return { token: jwt, account };
}

module.exports = {
  sendCode,
  verifyCode,
  CODE_TTL_SECONDS,
};
