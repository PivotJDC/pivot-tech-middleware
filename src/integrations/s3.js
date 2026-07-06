/**
 * S3 integration (AWS SDK v3) — permanent voicemail recording storage.
 *
 * Telnyx recording URLs expire after ~10 minutes, so we copy the audio into our
 * own bucket and serve playback via short-lived signed URLs generated on demand.
 *
 * The client is created lazily so importing this module is side-effect free and
 * requires no AWS credentials until an upload/sign actually happens (region +
 * credentials come from the standard AWS chain, same as SES).
 */
const {
  S3Client, PutObjectCommand, GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const { logger } = require('../utils/logger');

let client;

function getClient() {
  if (!client) {
    client = new S3Client({ region: config.aws.region });
  }
  return client;
}

/** The configured recordings bucket (empty string disables S3 archival). */
function bucket() {
  return config.aws.recordingsBucket || '';
}

/**
 * Fetch a remote recording (e.g. a Telnyx URL) and upload it to the recordings
 * bucket under `key`. Returns the key on success.
 * @param {{ key: string, sourceUrl: string, contentType?: string }} input
 * @returns {Promise<{ key: string }>}
 */
async function archiveRecording({ key, sourceUrl, contentType }) {
  if (!bucket()) throw new Error('no S3 recordings bucket configured');
  if (!sourceUrl) throw new Error('archiveRecording requires a sourceUrl');

  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(`failed to download recording (${res.status})`);
  }
  const body = Buffer.from(await res.arrayBuffer());

  // Telnyx <Play> only accepts audio/wav or audio/mpeg, and the download's own
  // content-type header can be a variant Telnyx rejects — so never trust it;
  // default to audio/wav (callers pass an explicit type only when it differs).
  await getClient().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: body,
    ContentType: contentType || 'audio/wav',
  }));
  logger.info({ key, bytes: body.length }, 'voicemail recording archived to S3');
  return { key };
}

/**
 * Upload a Buffer to the bucket under `key`. Used for decrypted MMS media.
 * @param {{ key: string, body: Buffer, contentType?: string }} input
 * @returns {Promise<{ key: string }>}
 */
async function uploadObject({ key, body, contentType }) {
  if (!bucket()) throw new Error('no S3 bucket configured');
  await getClient().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));
  return { key };
}

/** Read an object's body as a UTF-8 string (e.g. a Transcribe output JSON). */
async function getObjectText(key) {
  if (!bucket()) throw new Error('no S3 bucket configured');
  const out = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return out.Body.transformToString();
}

/**
 * Generate a short-lived signed GET URL for an object key.
 * @param {string} key
 * @param {number} [expiresIn] seconds (default 3600 = 1 hour)
 * @returns {Promise<string>}
 */
async function getSignedRecordingUrl(key, expiresIn = 3600) {
  if (!bucket()) throw new Error('no S3 recordings bucket configured');
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn },
  );
}

/** Canonical (unsigned) S3 https URL for an object — a stable reference. */
function objectUrl(key) {
  return `https://${bucket()}.s3.${config.aws.region}.amazonaws.com/${key}`;
}

/**
 * Extract the object key from one of our own canonical objectUrl() strings, or
 * null when the URL isn't ours (external) or is already presigned (has a query
 * string — re-signing would corrupt the key).
 * @param {string} url
 * @returns {string|null}
 */
function keyFromObjectUrl(url) {
  if (!bucket() || typeof url !== 'string') return null;
  const prefix = `https://${bucket()}.s3.${config.aws.region}.amazonaws.com/`;
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  if (!key || key.includes('?')) return null;
  return key;
}

/**
 * Presign a URL for GET if it points at one of our own S3 objects; otherwise
 * return it unchanged (external URLs pass through). Used to serve archived MMS
 * media to Acrobits with a fresh, short-lived link. Best-effort — on a signing
 * error the original URL is returned.
 * @param {string} url
 * @param {number} [expiresIn] seconds (default 3600)
 * @returns {Promise<string>}
 */
async function presignUrlIfOwn(url, expiresIn = 3600) {
  const key = keyFromObjectUrl(url);
  if (!key) return url;
  try {
    return await getSignedRecordingUrl(key, expiresIn);
  } catch {
    return url;
  }
}

/**
 * Resolve a playable URL for a voicemail row: a fresh signed S3 URL when it was
 * archived, else the stored recording_url (Telnyx fallback). null when neither.
 * @param {{ recording_s3_key?: string, recording_url?: string }} vm
 */
async function signedUrlForVoicemail(vm, expiresIn = 3600) {
  if (vm && vm.recording_s3_key && bucket()) {
    return getSignedRecordingUrl(vm.recording_s3_key, expiresIn);
  }
  return (vm && vm.recording_url) || null;
}

module.exports = {
  archiveRecording,
  uploadObject,
  getObjectText,
  getSignedRecordingUrl,
  signedUrlForVoicemail,
  presignUrlIfOwn,
  objectUrl,
  bucket,
};
