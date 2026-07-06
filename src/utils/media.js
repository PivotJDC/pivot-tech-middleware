/**
 * MMS media helpers — file-extension mapping and image compression.
 *
 * Both the outbound proxy (mmsService: Acrobits → Telnyx) and inbound archival
 * (messagingService: Telnyx → our S3) share these so compression behaves
 * identically in both directions.
 */
const sharp = require('sharp');
const { logger } = require('./logger');

// Images larger than this are compressed before upload (500 KB).
const MAX_MEDIA_BYTES = 500 * 1024;

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

/** True when the content-type is an image/* type. */
function isImage(contentType) {
  return String(contentType || '').toLowerCase().startsWith('image/');
}

/** Pick a file extension from the content-type, else the URL, else "bin". */
function extFor(contentType, url) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type];
  const match = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(String(url || ''));
  return match ? match[1].toLowerCase() : 'bin';
}

/**
 * Compress an oversized MMS image. Two passes: (1) resize to 1024px max width at
 * JPEG quality 75; (2) if still over the limit, resize to 800px at quality 60.
 * Non-images, already-small images, or any sharp failure return the input
 * unchanged (best-effort — compression must never break a send/archive).
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function compressImageIfNeeded(buffer, contentType) {
  if (!buffer || !isImage(contentType) || buffer.length <= MAX_MEDIA_BYTES) {
    return { buffer, contentType };
  }
  const originalBytes = buffer.length;
  try {
    let out = await sharp(buffer)
      .rotate() // honor EXIF orientation before stripping metadata
      .resize({ width: 1024, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    if (out.length > MAX_MEDIA_BYTES) {
      out = await sharp(buffer)
        .rotate()
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
    }
    logger.info(
      { originalBytes, compressedBytes: out.length, contentType },
      'MMS image compressed',
    );
    return { buffer: out, contentType: 'image/jpeg' };
  } catch (err) {
    logger.warn(
      { err: err.message, originalBytes },
      'MMS image compression failed; using original',
    );
    return { buffer, contentType };
  }
}

module.exports = {
  MAX_MEDIA_BYTES,
  isImage,
  extFor,
  compressImageIfNeeded,
};
