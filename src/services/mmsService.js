/**
 * MMS media proxy for Acrobits → Telnyx.
 *
 * Acrobits uploads outbound MMS attachments to its own media store and encrypts
 * them with AES-128-CTR (zero nonce) — Telnyx cannot fetch/decrypt those URLs.
 * So for each encrypted attachment we download it, decrypt it, re-upload the
 * plaintext to our S3 bucket, and hand Telnyx a short-lived presigned URL.
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

/**
 * Decrypt Acrobits media: AES-128-CTR with a zero nonce (16 zero bytes). CTR
 * has no padding. Throws on an invalid key (caught by the caller, which skips
 * the attachment).
 * @param {Buffer} encryptedBuffer
 * @param {string} hexKey - the AES-128 key as a hex string.
 * @returns {Buffer} the decrypted bytes.
 */
function decryptMedia(encryptedBuffer, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const nonce = Buffer.alloc(16, 0); // 16 zero bytes
  const decipher = nodeCrypto.createDecipheriv('aes-128-ctr', key, nonce);
  decipher.setAutoPadding(false); // CTR mode has no padding
  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
}

/** Resolve a single attachment to a Telnyx-fetchable URL, or null to skip. */
async function resolveOne(accountId, att) {
  const url = att && att.url;
  if (!url) return null;
  logger.info(
    {
      accountId, url, encrypted: !!att.encryptionKey, contentType: att.contentType,
    },
    'resolving MMS attachment',
  );
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
  const list = attachments || [];
  logger.info({ accountId, attachmentCount: list.length }, 'resolving MMS media');
  const results = await Promise.all(list.map((att) => resolveOne(accountId, att)));
  const resolved = results.filter(Boolean);
  logger.info(
    { accountId, requested: list.length, resolved: resolved.length },
    'MMS media resolution complete',
  );
  return resolved;
}

module.exports = {
  resolveMediaUrls,
  decryptMedia,
  extFor,
};
