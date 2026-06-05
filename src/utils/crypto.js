/**
 * Cryptographic helpers (CLAUDE.md "Security Rules"):
 *
 *  - Reversible: AES-256-GCM encrypt/decrypt for transfer PINs, which must be
 *    recoverable to submit a port (port_requests.pin_encrypted). The key comes
 *    from ENCRYPTION_KEY.
 *  - One-way: bcrypt hash/verify for SIP passwords, which are only ever compared
 *    (accounts.sip_password_hash), never recovered.
 *
 * Ciphertext format: "<iv>:<authTag>:<ciphertext>", each part base64. The GCM
 * auth tag makes tampering detectable — decrypt() throws if the payload was
 * altered or the wrong key is used.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const BCRYPT_ROUNDS = 12;

let cachedKey;

/**
 * Resolve ENCRYPTION_KEY to a 32-byte buffer. Accepts a 64-char hex string or a
 * 32-byte base64 string directly; any other non-empty value is run through
 * SHA-256 to derive a stable 32-byte key.
 */
function keyBuffer() {
  if (cachedKey) return cachedKey;
  const raw = config.encryptionKey;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not configured');
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
  } else {
    const decoded = Buffer.from(raw, 'base64');
    cachedKey = decoded.length === 32 ? decoded : crypto.createHash('sha256').update(raw).digest();
  }
  return cachedKey;
}

/** Encrypt UTF-8 plaintext. Returns "iv:tag:ciphertext" (base64 parts). */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt expects a string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString('base64')).join(':');
}

/** Decrypt a payload produced by encrypt(). Throws if tampered or wrong key. */
function decrypt(payload) {
  if (typeof payload !== 'string' || payload.split(':').length !== 3) {
    throw new TypeError('decrypt expects an "iv:tag:ciphertext" string');
  }
  const [ivB64, tagB64, ctB64] = payload.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** Hash a SIP password (or any secret) for storage. */
function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

/** Constant-time verify of a plaintext against a bcrypt hash. */
function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

/** Generate a random, URL-safe secret (e.g. a generated SIP password). */
function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Exposed for tests to reset the memoized key when config is re-mocked.
function resetKeyCache() {
  cachedKey = undefined;
}

module.exports = {
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
  randomSecret,
  resetKeyCache,
};
