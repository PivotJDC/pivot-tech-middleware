/**
 * Voicemail service — the `voicemails` table.
 *
 * Voicemails are created from the TeXML voicemail flow (the recording callback
 * in routes/v1/voice.js) and read/managed by customers (via /v1/account) and
 * admins. Routes call in here; this module only touches the DB.
 */
const db = require('../db');
const { logger } = require('../utils/logger');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Clamp pagination opts to { limit, offset }. */
function parsePage(opts = {}) {
  const rawLimit = Number.parseInt(opts.limit, 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0
    ? DEFAULT_LIMIT
    : Math.min(rawLimit, MAX_LIMIT);
  const rawOffset = Number.parseInt(opts.offset, 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
  return { limit, offset };
}

/**
 * Store a new voicemail. tenant_id comes from the owning account (resolved in
 * the webhook by the called number).
 * @param {{ accountId, tenantId, callerNumber, callerName?, recordingUrl?,
 *           recordingSid?, durationSeconds? }} input
 * @returns {Promise<object>} the inserted row.
 */
async function createVoicemail({
  accountId, tenantId, callerNumber, callerName,
  recordingUrl, recordingSid, durationSeconds,
} = {}) {
  const { rows } = await db.query(
    `INSERT INTO voicemails
       (account_id, tenant_id, caller_number, caller_name, duration_seconds,
        recording_url, recording_sid)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0), $6, $7)
     RETURNING *`,
    [
      accountId, tenantId, callerNumber, callerName || null,
      durationSeconds == null ? null : Number(durationSeconds),
      recordingUrl || null, recordingSid || null,
    ],
  );
  logger.info({ accountId, recordingSid: recordingSid || null }, 'voicemail stored');
  return rows[0];
}

/**
 * List an account's voicemails, newest first. Optional tenantId is a
 * defense-in-depth scope (admin, non-super_admin).
 */
async function getVoicemails(accountId, opts, tenantId) {
  const { limit, offset } = parsePage(opts);
  const params = [accountId];
  let where = 'account_id = $1';
  if (tenantId) {
    params.push(tenantId);
    where += ` AND tenant_id = $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT * FROM voicemails
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

/** Build a `WHERE id = $1 [AND account_id/tenant_id]` clause from a scope. */
function scopedWhere(voicemailId, scope = {}) {
  const params = [voicemailId];
  let where = 'id = $1';
  if (scope.accountId) {
    params.push(scope.accountId);
    where += ` AND account_id = $${params.length}`;
  }
  if (scope.tenantId) {
    params.push(scope.tenantId);
    where += ` AND tenant_id = $${params.length}`;
  }
  return { where, params };
}

/**
 * Mark a voicemail read. `scope` optionally restricts by account/tenant so a
 * caller can only touch their own. Returns the row, or null if not found/owned.
 */
async function markAsRead(voicemailId, scope = {}) {
  const { where, params } = scopedWhere(voicemailId, scope);
  const { rows } = await db.query(
    `UPDATE voicemails SET is_read = true WHERE ${where} RETURNING *`,
    params,
  );
  return rows[0] || null;
}

/** Delete a voicemail (scoped). Returns { deleted: true, id } or null. */
async function deleteVoicemail(voicemailId, scope = {}) {
  const { where, params } = scopedWhere(voicemailId, scope);
  const { rows } = await db.query(
    `DELETE FROM voicemails WHERE ${where} RETURNING id`,
    params,
  );
  return rows[0] ? { deleted: true, id: rows[0].id } : null;
}

/** Unread voicemail count for an account. */
async function getVoicemailCount(accountId) {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS count FROM voicemails WHERE account_id = $1 AND is_read = false',
    [accountId],
  );
  return rows[0] ? rows[0].count : 0;
}

/**
 * Attach a transcription. Matches by recording_sid when present, else falls
 * back to the account's most recent voicemail. Returns the row or null.
 */
async function attachTranscription({ accountId, recordingSid, transcription } = {}) {
  if (recordingSid) {
    const { rows } = await db.query(
      'UPDATE voicemails SET transcription = $1 WHERE recording_sid = $2 RETURNING *',
      [transcription, recordingSid],
    );
    if (rows[0]) return rows[0];
  }
  if (!accountId) return null;
  const { rows } = await db.query(
    `UPDATE voicemails SET transcription = $1
      WHERE id = (
        SELECT id FROM voicemails WHERE account_id = $2 ORDER BY created_at DESC LIMIT 1
      )
    RETURNING *`,
    [transcription, accountId],
  );
  return rows[0] || null;
}

/** Set an account's custom voicemail greeting URL (recorded via the IVR). */
async function setGreeting(accountId, greetingUrl) {
  const { rows } = await db.query(
    'UPDATE accounts SET voicemail_greeting_url = $1 WHERE id = $2 RETURNING id',
    [greetingUrl || null, accountId],
  );
  logger.info({ accountId }, 'voicemail greeting set');
  return rows[0] || null;
}

/** Clear an account's custom greeting (fall back to the default <Say>). */
async function clearGreeting(accountId) {
  const { rows } = await db.query(
    'UPDATE accounts SET voicemail_greeting_url = NULL WHERE id = $1 RETURNING id',
    [accountId],
  );
  logger.info({ accountId }, 'voicemail greeting cleared');
  return rows[0] || null;
}

module.exports = {
  createVoicemail,
  getVoicemails,
  markAsRead,
  deleteVoicemail,
  getVoicemailCount,
  attachTranscription,
  setGreeting,
  clearGreeting,
};
