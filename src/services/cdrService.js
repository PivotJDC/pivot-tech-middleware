/**
 * Call / message detail record (CDR) service.
 *
 * Records are written from Telnyx voice + messaging webhooks and tied to an
 * account by matching the call/message numbers against accounts.phone_e164:
 * the side that is one of our DIDs determines ownership AND direction (our DID
 * is unique, so this is unambiguous). A supplied `direction` is honored when
 * present; otherwise it is inferred.
 *
 * recordCall/recordMessage are idempotent: they UPSERT on call_sid / message_id
 * (manual UPDATE-then-INSERT, since the migrations index those columns without a
 * UNIQUE constraint) so repeated status webhooks for the same call/message
 * update the row rather than duplicating it.
 *
 * This module only touches the DB (no HTTP, no other services) to avoid import
 * cycles with messagingService.
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

/** Account (id + tenant_id) that owns an E.164 number (one of our DIDs), or null. */
async function accountForNumber(num) {
  if (!num) return null;
  const { rows } = await db.query(
    'SELECT id, tenant_id FROM accounts WHERE phone_e164 = $1',
    [num],
  );
  return rows[0] || null;
}

/**
 * Resolve { accountId, tenantId, direction } from from/to. Honors an explicit
 * valid direction (matching `from` for outbound, `to` for inbound); otherwise
 * infers direction from whichever side is one of our numbers. The webhook has no
 * tenant context, so we derive tenant_id from the matched account.
 */
async function resolveOwnership(direction, from, to) {
  const pick = (acct, dir) => (acct
    ? { accountId: acct.id, tenantId: acct.tenant_id, direction: dir }
    : null);

  if (direction === 'outbound') {
    return pick(await accountForNumber(from), 'outbound')
      || { accountId: null, tenantId: null, direction: null };
  }
  if (direction === 'inbound') {
    return pick(await accountForNumber(to), 'inbound')
      || { accountId: null, tenantId: null, direction: null };
  }
  const out = pick(await accountForNumber(from), 'outbound');
  if (out) return out;
  const inb = pick(await accountForNumber(to), 'inbound');
  if (inb) return inb;
  return { accountId: null, tenantId: null, direction: null };
}

/**
 * Record (or update) a call from a voice status webhook. UPSERT by call_sid.
 * Returns the row, or null when no account owns either number.
 * @param {{ callSid, direction?, from, to, status?, durationSeconds?, startedAt?, endedAt? }} input
 */
async function recordCall({
  callSid, direction, from, to, status, durationSeconds, startedAt, endedAt,
} = {}) {
  if (!callSid) return null;
  const { accountId, tenantId, direction: dir } = await resolveOwnership(direction, from, to);
  if (!accountId) {
    logger.warn({ callSid }, 'call record for a number we do not own; ignored');
    return null;
  }
  const finalStatus = status || 'unknown';
  const duration = durationSeconds == null ? null : Number(durationSeconds);

  // UPSERT by call_sid: update an existing row in place (COALESCE so a partial
  // status event doesn't wipe data we already captured), else insert.
  const updated = await db.query(
    `UPDATE call_records
        SET status = $1,
            duration_seconds = COALESCE($2, duration_seconds),
            started_at = COALESCE($3, started_at),
            ended_at = COALESCE($4, ended_at)
      WHERE call_sid = $5
    RETURNING *`,
    [finalStatus, duration, startedAt || null, endedAt || null, callSid],
  );
  if (updated.rows[0]) return updated.rows[0];

  const inserted = await db.query(
    `INSERT INTO call_records
       (account_id, tenant_id, call_sid, direction, from_number, to_number, status,
        duration_seconds, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0), $9, $10)
     RETURNING *`,
    [
      accountId, tenantId, callSid, dir, from, to, finalStatus,
      duration, startedAt || null, endedAt || null,
    ],
  );
  logger.info({ accountId, callSid, direction: dir }, 'call record stored');
  return inserted.rows[0];
}

/**
 * Record (or update) a message from a messaging webhook. UPSERT by message_id.
 * Returns the row, or null when no account owns either number.
 * @param {{ messageId, direction?, from, to, status?, messageType? }} input
 */
async function recordMessage({
  messageId, direction, from, to, status, messageType,
} = {}) {
  if (!messageId) return null;
  const { accountId, tenantId, direction: dir } = await resolveOwnership(direction, from, to);
  if (!accountId) {
    logger.warn({ messageId }, 'message record for a number we do not own; ignored');
    return null;
  }
  const finalStatus = status || 'unknown';
  const type = messageType === 'mms' ? 'mms' : 'sms';

  const updated = await db.query(
    'UPDATE message_records SET status = $1 WHERE message_id = $2 RETURNING *',
    [finalStatus, messageId],
  );
  if (updated.rows[0]) return updated.rows[0];

  const inserted = await db.query(
    `INSERT INTO message_records
       (account_id, tenant_id, message_id, direction, from_number, to_number, status, message_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [accountId, tenantId, messageId, dir, from, to, finalStatus, type],
  );
  logger.info({ accountId, messageId, direction: dir }, 'message record stored');
  return inserted.rows[0];
}

/**
 * Paginated call history for an account, newest first. When tenantId is given,
 * additionally scopes to that tenant (defense in depth for tenant isolation).
 */
async function getCallHistory(accountId, opts, tenantId) {
  const { limit, offset } = parsePage(opts);
  const params = [accountId];
  let where = 'account_id = $1';
  if (tenantId) {
    params.push(tenantId);
    where += ` AND tenant_id = $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT * FROM call_records
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

/** Paginated message history for an account, newest first (optionally tenant-scoped). */
async function getMessageHistory(accountId, opts, tenantId) {
  const { limit, offset } = parsePage(opts);
  const params = [accountId];
  let where = 'account_id = $1';
  if (tenantId) {
    params.push(tenantId);
    where += ` AND tenant_id = $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT * FROM message_records
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Combined call + message history for an account, newest first. Each row carries
 * a `record_type` ('call' | 'message'); type-specific columns are null on the
 * other kind.
 */
async function getAccountCdrs(accountId, opts = {}) {
  const { limit, offset } = parsePage(opts);
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT 'call'::text AS record_type, id, account_id, call_sid AS ref,
              direction, from_number, to_number, status,
              duration_seconds, NULL::text AS message_type, created_at
         FROM call_records WHERE account_id = $1
       UNION ALL
       SELECT 'message'::text AS record_type, id, account_id, message_id AS ref,
              direction, from_number, to_number, status,
              NULL::int AS duration_seconds, message_type, created_at
         FROM message_records WHERE account_id = $1
     ) combined
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [accountId, limit, offset],
  );
  return rows;
}

module.exports = {
  recordCall,
  recordMessage,
  getCallHistory,
  getMessageHistory,
  getAccountCdrs,
};
