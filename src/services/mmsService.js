/**
 * MMS media proxy for Acrobits → Telnyx.
 *
 * Acrobits uploads outbound MMS attachments to its own media store and encrypts
 * them (AES-128) — Telnyx cannot fetch/decrypt those URLs. So for each encrypted
 * attachment we download it, decrypt it, re-upload the plaintext to our S3
 * bucket, and hand Telnyx a short-lived presigned URL instead.
 *
 * Best-effort: a download/decrypt/upload failure skips that one attachment (with
 * a warning) rather than failing the whole send. Unencrypted attachments pass
 * through unchanged.
 */
const nodeCrypto = require('crypto');
const s3 = require('../integrations/s3');
const { logger } = require('../utils/logger');

// content-type → file extension for the S3 object key.
const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
};

/** Pick a file extension from the content-type, else the URL, else "bin". */
function extFor(contentType, url) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type];
  const match = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(String(url || ''));
  return match ? match[1].toLowerCase() : 'bin';
}

/** Decrypt with a specific algorithm/IV/padding. Buffer, or null on error. */
function decrypt(algorithm, key, iv, data, autoPad) {
  try {
    const decipher = nodeCrypto.createDecipheriv(algorithm, key, iv);
    decipher.setAutoPadding(autoPad);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    return null;
  }
}

/**
 * Decrypt Acrobits media. AES-128, key is a hex string; the mode isn't
 * documented, so try ECB (no IV) then CBC (zero IV). PKCS7-padded modes are
 * tried FIRST — bad padding throws, which is a reliable signal that the mode is
 * wrong, so the ECB→CBC fallback actually works. Unpadded variants are a last
 * resort (they never throw, so they can only be trusted once padding is ruled
 * out).
 * @returns {Buffer|null}
 */
function decryptMedia(data, hexKey) {
  let key;
  try {
    key = Buffer.from(String(hexKey || ''), 'hex');
  } catch {
    return null;
  }
  if (key.length < 16) return null;
  const k = key.subarray(0, 16); // AES-128
  const zeroIv = Buffer.alloc(16);
  return decrypt('aes-128-ecb', k, null, data, true)
    || decrypt('aes-128-cbc', k, zeroIv, data, true)
    || decrypt('aes-128-ecb', k, null, data, false)
    || decrypt('aes-128-cbc', k, zeroIv, data, false);
}

/** Resolve a single attachment to a Telnyx-fetchable URL, or null to skip. */
async function resolveOne(accountId, att) {
  const url = att && att.url;
  if (!url) return null;
  // Unencrypted → hand the original URL straight to Telnyx.
  if (!att.encryptionKey) return url;

  if (!s3.bucket()) {
    logger.warn({ accountId }, 'no S3 bucket configured; cannot proxy encrypted MMS media');
    return null;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const encrypted = Buffer.from(await res.arrayBuffer());
    const decrypted = decryptMedia(encrypted, att.encryptionKey);
    if (!decrypted) throw new Error('decryption failed');

    const key = `mms/${accountId}/${nodeCrypto.randomUUID()}.${extFor(att.contentType, url)}`;
    await s3.uploadObject({ key, body: decrypted, contentType: att.contentType });
    const signed = await s3.getSignedRecordingUrl(key, 3600);
    logger.info({ accountId, key, bytes: decrypted.length }, 'proxied encrypted MMS media to S3');
    return signed;
  } catch (err) {
    logger.warn({ accountId, err: err.message }, 'MMS media proxy failed; skipping attachment');
    return null;
  }
}

/**
 * Resolve Acrobits attachments into Telnyx-fetchable media URLs (order
 * preserved). Encrypted attachments are decrypted + re-hosted on S3; plain ones
 * pass through; failures are dropped.
 * @param {string} accountId
 * @param {Array<{ url: string, contentType?: string, encryptionKey?: string }>} attachments
 * @returns {Promise<string[]>}
 */
async function resolveMediaUrls(accountId, attachments = []) {
  const results = await Promise.all(
    (attachments || []).map((att) => resolveOne(accountId, att)),
  );
  return results.filter(Boolean);
}

module.exports = {
  resolveMediaUrls,
  decryptMedia,
  extFor,
};
