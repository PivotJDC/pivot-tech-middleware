/**
 * MMS media helpers — file-extension mapping and image/video compression.
 *
 * Both the outbound proxy (mmsService: Acrobits → Telnyx) and inbound archival
 * (messagingService: Telnyx → our S3) share these so compression behaves
 * identically in both directions.
 */
const { execFile } = require('child_process');
const { promises: fs } = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const sharp = require('sharp');
const { logger } = require('./logger');

// Media larger than this is compressed before upload (500 KB) — the carrier MMS
// ceiling. Also the ffmpeg hard file-size cap (-fs) for video.
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

/** True when the content-type is a video/* type. */
function isVideo(contentType) {
  return String(contentType || '').toLowerCase().startsWith('video/');
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

/** Run ffmpeg with the given args; resolves on success, rejects on error. */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    // execFile (no shell) — args are passed as an array, so no injection risk.
    // ffmpeg logs to stderr; cap it and the runtime so a bad input can't hang us.
    execFile('ffmpeg', args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Compress an oversized MMS video with ffmpeg (H.264/AAC MP4): resize to 480px
 * width, CRF 28, faststart, and a hard 500 KB cap (-fs). The buffer is written to
 * a temp file, transcoded, read back, and the temp files are removed. Non-videos,
 * already-small videos, or any ffmpeg failure return the input unchanged
 * (best-effort — compression must never break a send/archive). Requires ffmpeg on
 * the host (installed in the Docker image).
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function compressVideoIfNeeded(buffer, contentType) {
  if (!buffer || !isVideo(contentType) || buffer.length <= MAX_MEDIA_BYTES) {
    return { buffer, contentType };
  }
  const originalBytes = buffer.length;
  const id = nodeCrypto.randomUUID();
  const inputPath = path.join(os.tmpdir(), `mms-${id}-in.${extFor(contentType)}`);
  const outputPath = path.join(os.tmpdir(), `mms-${id}-out.mp4`);
  try {
    await fs.writeFile(inputPath, buffer);
    await runFfmpeg([
      '-y',
      '-loglevel', 'error',
      '-i', inputPath,
      '-vf', 'scale=480:-2', // 480px width, keep aspect (height rounded to even)
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart', // streaming-friendly (moov atom up front)
      '-fs', '500000', // hard 500 KB output cap
      outputPath,
    ]);
    const out = await fs.readFile(outputPath);
    logger.info(
      { originalBytes, compressedBytes: out.length, contentType },
      'MMS video compressed',
    );
    return { buffer: out, contentType: 'video/mp4' };
  } catch (err) {
    logger.warn(
      { err: err.message, originalBytes },
      'MMS video compression failed; using original',
    );
    return { buffer, contentType };
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

/**
 * Compress oversized MMS media by type: images via sharp, videos via ffmpeg;
 * anything else passes through unchanged. Best-effort throughout.
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function compressMediaIfNeeded(buffer, contentType) {
  if (isImage(contentType)) return compressImageIfNeeded(buffer, contentType);
  if (isVideo(contentType)) return compressVideoIfNeeded(buffer, contentType);
  return { buffer, contentType };
}

module.exports = {
  MAX_MEDIA_BYTES,
  isImage,
  isVideo,
  extFor,
  compressImageIfNeeded,
  compressVideoIfNeeded,
  compressMediaIfNeeded,
};
