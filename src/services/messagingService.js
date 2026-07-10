/**
 * Messaging service — SMS/MMS business logic.
 *
 * Telnyx can't bridge messaging over SIP/SIMPLE to the Acrobits dialer, so all
 * messages flow through the middleware: outbound via the Telnyx REST Messaging
 * API, inbound via Telnyx messaging webhooks. Every message is logged to the
 * `messages` table and delivery status is reconciled from webhook events.
 *
 * Routes call into here; this module never touches HTTP.
 */
const db = require('../db');
const telnyx = require('../integrations/telnyx');
const s3 = require('../integrations/s3');
const accountService = require('./accountService');
const pushService = require('./pushService');
const cdrService = require('./cdrService');
const { errors } = require('../middleware/errorHandler');
const {
  extFor, compressMediaIfNeeded, isVideo, generateVideoThumbnail,
} = require('../utils/media');
const { logger } = require('../utils/logger');

// Telnyx messaging event_type -> the CDR status we log for it.
const CDR_STATUS_BY_EVENT = {
  'message.received': 'received',
  'message.sent': 'sent',
  'message.delivered': 'delivered',
  'message.sending_failed': 'failed',
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Clamp/validate a pagination limit. */
function parseLimit(value) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Send an SMS/MMS from an account's own number.
 * @param {string} accountId
 * @param {{ to: string, body?: string, mediaUrls?: string[] }} input
 * @returns {Promise<object>} the persisted outbound message row.
 */
async function sendMessage(accountId, input = {}) {
  const account = await accountService.getAccountById(accountId); // throws NOT_FOUND
  if (account.status !== 'active') {
    throw errors.validation('Account must be active to send messages.', 'status');
  }
  if (!account.phone_e164) {
    throw errors.validation('Account has no assigned number to send from.', 'account');
  }

  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const mediaUrls = Array.isArray(input.mediaUrls) ? input.mediaUrls : [];
  if (!to) {
    throw errors.validation('A recipient `to` number is required.', 'to');
  }
  if (!body && mediaUrls.length === 0) {
    throw errors.validation('A message body or media is required.', 'body');
  }

  const sent = await telnyx.sendMessage({
    from: account.phone_e164,
    to,
    body,
    mediaUrls,
  });

  const { rows } = await db.query(
    `INSERT INTO messages
       (account_id, direction, from_number, to_number, body, media_urls,
        telnyx_message_id, status)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [accountId, account.phone_e164, to, body, mediaUrls, (sent && sent.id) || null, 'queued'],
  );
  logger.info(
    { accountId, telnyxMessageId: (sent && sent.id) || null, mms: mediaUrls.length > 0 },
    'outbound message sent',
  );
  return rows[0];
}

/**
 * Send a group SMS/MMS from an account's own number to several recipients.
 * Uses the Telnyx Group MMS endpoint and tags the stored row with a `group_id`
 * (Telnyx's group identifier) plus the recipient list in `cc`, so the Acrobits
 * fetch endpoint threads the whole group together.
 * @param {string} accountId
 * @param {{ to: string[], body?: string, mediaUrls?: string[] }} input
 * @returns {Promise<object>} the persisted outbound message row.
 */
async function sendGroupMessage(accountId, input = {}) {
  const account = await accountService.getAccountById(accountId); // throws NOT_FOUND
  if (account.status !== 'active') {
    throw errors.validation('Account must be active to send messages.', 'status');
  }
  if (!account.phone_e164) {
    throw errors.validation('Account has no assigned number to send from.', 'account');
  }

  const to = Array.isArray(input.to)
    ? input.to.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean)
    : [];
  const body = typeof input.body === 'string' ? input.body : '';
  const mediaUrls = Array.isArray(input.mediaUrls) ? input.mediaUrls : [];
  if (to.length < 2) {
    throw errors.validation('A group message needs at least two recipients.', 'to');
  }
  if (!body && mediaUrls.length === 0) {
    throw errors.validation('A message body or media is required.', 'body');
  }

  const sent = await telnyx.sendGroupMessage({
    from: account.phone_e164,
    to,
    body,
    mediaUrls,
  });
  // DECISION: thread by Telnyx's group id (group_message_id, falling back to the
  // message id). Inbound replies carry the same group_message_id, so both sides
  // of the group share one stream_id in /fetch.
  const groupId = (sent && (sent.group_message_id || sent.id)) || null;

  const { rows } = await db.query(
    `INSERT INTO messages
       (account_id, direction, from_number, to_number, body, media_urls,
        telnyx_message_id, status, group_id, cc)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, 'queued', $7, $8)
     RETURNING *`,
    // to_number is a single VARCHAR(20); store the first recipient there (the
    // full list lives in cc). Threading uses group_id, not to_number.
    [accountId, account.phone_e164, to[0], body, mediaUrls, (sent && sent.id) || null, groupId, to],
  );
  logger.info(
    {
      accountId, groupId, recipients: to.length, mms: mediaUrls.length > 0,
    },
    'outbound group message sent',
  );
  return rows[0];
}

/**
 * Archive inbound Telnyx media to our S3 bucket (Telnyx media URLs expire).
 * Downloads each item, compresses oversized images, and uploads under
 * mms-inbound/{accountId}/{messageId}_{index}.{ext}. Returns an array aligned to
 * `mediaList`: the S3 canonical URL on success, or the original Telnyx URL as a
 * fallback when a single item fails. Best-effort — callers ignore failures.
 * @param {string} accountId
 * @param {string} messageId
 * @param {Array<{ url: string, content_type?: string }>} mediaList
 * @returns {Promise<string[]>}
 */
async function archiveInboundMedia(accountId, messageId, mediaList = []) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  return Promise.all(list.map(async (m, index) => {
    const url = m && m.url;
    if (!url) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      let buffer = Buffer.from(await res.arrayBuffer());
      let contentType = m.content_type || res.headers.get('content-type') || 'application/octet-stream';
      ({ buffer, contentType } = await compressMediaIfNeeded(buffer, contentType));
      const key = `mms-inbound/${accountId}/${messageId}_${index}.${extFor(contentType, url)}`;
      await s3.uploadObject({ key, body: buffer, contentType });
      // Best-effort: store a video thumbnail alongside the clip ({key}_thumb.jpg).
      if (isVideo(contentType)) {
        try {
          const thumb = await generateVideoThumbnail(buffer, contentType);
          if (thumb) {
            await s3.uploadObject({ key: `${key}_thumb.jpg`, body: thumb, contentType: 'image/jpeg' });
          }
        } catch (thumbErr) {
          logger.warn({ accountId, messageId, err: thumbErr.message }, 'inbound video thumbnail failed');
        }
      }
      logger.info({ accountId, messageId, key }, 'inbound MMS media archived to S3');
      return s3.objectUrl(key);
    } catch (err) {
      logger.warn(
        { accountId, messageId, err: err.message },
        'inbound MMS media archival failed; keeping Telnyx URL',
      );
      return url; // fallback to the original Telnyx URL
    }
  })).then((urls) => urls.filter(Boolean));
}

/**
 * Persist an inbound message from a Telnyx `message.received` webhook payload.
 * @param {object} payload - the Telnyx message payload (data.payload).
 * @returns {Promise<object|null>} the inbound row, or null if no account owns
 *   the recipient number (logged and ignored so the webhook still 200s).
 */
async function handleInboundMessage(payload = {}) {
  const from = (payload.from && payload.from.phone_number) || payload.from || '';
  // Telnyx delivers `to` as an array of recipients; our DID is the first.
  const toEntry = Array.isArray(payload.to) ? payload.to[0] : payload.to;
  const to = (toEntry && toEntry.phone_number) || toEntry || '';
  const body = payload.text || '';
  const mediaUrls = Array.isArray(payload.media)
    ? payload.media.map((m) => m.url).filter(Boolean)
    : [];
  const telnyxMessageId = payload.id || null;

  // Group message: Telnyx includes a `cc` array listing the other participants.
  // Its entries may be objects ({ phone_number }) or bare strings — normalize to
  // E.164 strings. A non-empty cc marks this as a group thread; store the group
  // id (group_message_id, falling back to the message id) so /fetch can thread
  // all group messages together.
  const cc = Array.isArray(payload.cc)
    ? payload.cc.map((c) => (c && c.phone_number) || c).filter(Boolean)
    : [];
  const groupId = cc.length > 0 ? (payload.group_message_id || telnyxMessageId) : null;

  const account = await db.query(
    'SELECT id FROM accounts WHERE phone_e164 = $1',
    [to],
  );
  if (account.rows.length === 0) {
    logger.warn({ to, telnyxMessageId }, 'inbound message for unknown number; ignored');
    return null;
  }
  const accountId = account.rows[0].id;

  // Idempotency: Telnyx can deliver the same webhook more than once. If we've
  // already stored this message, return the existing row instead of inserting a
  // duplicate (which would double it up in the fetch response).
  if (telnyxMessageId) {
    const existing = await db.query(
      'SELECT * FROM messages WHERE telnyx_message_id = $1',
      [telnyxMessageId],
    );
    if (existing.rows.length > 0) {
      logger.info({ accountId, telnyxMessageId }, 'duplicate inbound message skipped');
      return existing.rows[0];
    }
  }

  const { rows } = await db.query(
    `INSERT INTO messages
       (account_id, direction, from_number, to_number, body, media_urls,
        telnyx_message_id, status, group_id, cc)
     VALUES ($1, 'inbound', $2, $3, $4, $5, $6, 'received', $7, $8)
     ON CONFLICT (telnyx_message_id) WHERE telnyx_message_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [accountId, from, to, body, mediaUrls, telnyxMessageId, groupId, cc],
  );
  const inbound = rows[0];
  if (!inbound) {
    // Lost a concurrent-insert race (the UNIQUE index rejected the duplicate) —
    // return the row the other delivery stored. No error, no retry.
    const existing = await db.query(
      'SELECT * FROM messages WHERE telnyx_message_id = $1',
      [telnyxMessageId],
    );
    logger.info({ accountId, telnyxMessageId }, 'duplicate inbound message resolved via conflict');
    return existing.rows[0] || null;
  }
  logger.info({ accountId, telnyxMessageId }, 'inbound message stored');

  // Best-effort: archive Telnyx media to our S3 (Telnyx URLs expire), compressing
  // oversized images. Rewrite media_urls to the durable S3 URLs. Never let this
  // break inbound storage — a failure keeps the original Telnyx URLs.
  if (mediaUrls.length > 0 && s3.bucket()) {
    try {
      const archived = await archiveInboundMedia(accountId, inbound.id, payload.media);
      if (archived.length > 0) {
        await db.query('UPDATE messages SET media_urls = $1 WHERE id = $2', [archived, inbound.id]);
        inbound.media_urls = archived;
      }
    } catch (err) {
      logger.warn(
        { accountId, messageId: inbound.id, err: err.message },
        'inbound MMS archival failed',
      );
    }
  }

  // Wake the Acrobits app so it fetches the new message (best-effort; never
  // throws, so a push failure can't break inbound storage). streamId is the
  // sender's number so the push threads into the same conversation as /fetch.
  await pushService.sendMessagePush(accountId, {
    from: inbound.from_number,
    body: inbound.body,
    messageId: inbound.id,
    // Group messages thread by group_id (matching /fetch), 1:1 by the sender.
    streamId: inbound.group_id || inbound.from_number,
  });
  return inbound;
}

/**
 * List an account's messages, newest first, with cursor pagination.
 * @param {string} accountId
 * @param {{ limit?: number|string, before?: string }} [opts] - `before` is an
 *   ISO timestamp cursor; only messages created strictly before it are returned.
 */
async function getMessages(accountId, opts = {}) {
  const limit = parseLimit(opts.limit);
  const params = [accountId];
  let where = 'account_id = $1';
  if (opts.before) {
    params.push(opts.before);
    where += ` AND created_at < $${params.length}`;
  }
  params.push(limit);
  const { rows } = await db.query(
    `SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/**
 * List the conversation between an account and one other number, newest first.
 * @param {string} accountId
 * @param {string} otherNumber - the other party's E.164.
 * @param {{ limit?: number|string, before?: string }} [opts]
 */
async function getConversation(accountId, otherNumber, opts = {}) {
  const limit = parseLimit(opts.limit);
  const params = [accountId, otherNumber];
  let where = 'account_id = $1 AND (from_number = $2 OR to_number = $2)';
  if (opts.before) {
    params.push(opts.before);
    where += ` AND created_at < $${params.length}`;
  }
  params.push(limit);
  const { rows } = await db.query(
    `SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Messages of one direction created after a given message id (its created_at
 * watermark). Returned oldest-first so the Acrobits app appends them in order.
 * With no/unknown lastId, returns the most recent window (capped) chronologically.
 */
async function getDirectionSince(accountId, direction, lastId) {
  const params = [accountId, direction];
  let where = 'account_id = $1 AND direction = $2';
  if (lastId) {
    params.push(lastId);
    where += ` AND created_at > (SELECT created_at FROM messages WHERE id = $${params.length})`;
  }
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT 200
     ) recent ORDER BY created_at ASC`,
    params,
  );
  return rows;
}

/**
 * Fetch new inbound + outbound messages for the Acrobits app's polling endpoint.
 * @param {string} accountId
 * @param {string} [lastReceivedId] - last inbound sms_id the app has.
 * @param {string} [lastSentId] - last outbound sms_id the app has.
 * @returns {Promise<{ received: object[], sent: object[] }>}
 */
async function fetchForAcrobits(accountId, lastReceivedId, lastSentId) {
  const [received, sent] = await Promise.all([
    getDirectionSince(accountId, 'inbound', lastReceivedId),
    getDirectionSince(accountId, 'outbound', lastSentId),
  ]);
  return { received, sent };
}

/**
 * Update delivery status on a message, keyed by its Telnyx message id (webhook).
 * @param {string} telnyxMessageId
 * @param {string} status - 'sent' | 'delivered' | 'failed' | ...
 * @param {string} [errorMessage]
 * @returns {Promise<object|null>} the updated row, or null if not found.
 */
async function updateMessageStatus(telnyxMessageId, status, errorMessage = null) {
  if (!telnyxMessageId) return null;
  const { rows } = await db.query(
    `UPDATE messages
        SET status = $1, error_message = $2, updated_at = NOW()
      WHERE telnyx_message_id = $3
    RETURNING *`,
    [status, errorMessage, telnyxMessageId],
  );
  return rows[0] || null;
}

/**
 * Dispatch a Telnyx messaging webhook event to the right handler. Returns a
 * small descriptor for logging/response; never throws on unknown event types.
 * @param {object} body - the raw Telnyx webhook body.
 */
async function handleMessagingWebhook(body = {}) {
  const data = body.data || {};
  const eventType = data.event_type;
  const payload = data.payload || {};
  if (!eventType) return { ignored: true };

  // Best-effort CDR log (separate from the `messages` table). Upserts by
  // message_id so status events update the same record. Never breaks handling.
  if (payload.id && CDR_STATUS_BY_EVENT[eventType]) {
    const from = (payload.from && payload.from.phone_number) || payload.from || '';
    const toEntry = Array.isArray(payload.to) ? payload.to[0] : payload.to;
    const to = (toEntry && toEntry.phone_number) || toEntry || '';

    // Tag the CDR with the owning account (and its tenant) so tenant-scoped
    // admin views can see it. For inbound the subscriber's number is `to`; for
    // outbound it's `from`. DECISION: use the existing lookupByPhoneE164 (raw
    // row with id + tenant_id) rather than a separate lookupByPhone helper.
    const subscriberNumber = payload.direction === 'inbound' ? to : from;
    const account = await accountService.lookupByPhoneE164(subscriberNumber);

    try {
      await cdrService.recordMessage({
        messageId: payload.id,
        direction: payload.direction === 'outbound' || payload.direction === 'inbound'
          ? payload.direction
          : undefined,
        from,
        to,
        status: CDR_STATUS_BY_EVENT[eventType],
        messageType: String(payload.type || '').toLowerCase() === 'mms' ? 'mms' : 'sms',
        accountId: account ? account.id : null,
        tenantId: account ? account.tenant_id : null,
      });
    } catch (err) {
      logger.error({ err: err.message, messageId: payload.id }, 'failed to record message CDR');
    }
  }

  switch (eventType) {
    case 'message.received':
      return { handled: eventType, message: await handleInboundMessage(payload) };
    case 'message.sent':
      return { handled: eventType, message: await updateMessageStatus(payload.id, 'sent') };
    case 'message.delivered':
      return { handled: eventType, message: await updateMessageStatus(payload.id, 'delivered') };
    case 'message.sending_failed': {
      const errs = Array.isArray(payload.errors) ? payload.errors : [];
      const detail = errs.length ? (errs[0].detail || errs[0].title || null) : null;
      return {
        handled: eventType,
        message: await updateMessageStatus(payload.id, 'failed', detail),
      };
    }
    default:
      return { ignored: eventType };
  }
}

/**
 * Insert a synthetic inbound message into the `messages` table (the store the
 * Acrobits fetch/thread view reads). Used to deliver a voicemail transcription
 * into the subscriber's Messages tab, threaded with the caller (stream_id =
 * from_number). `createdAt` lets it carry the voicemail's timestamp.
 * @param {{ accountId, from, to, body, createdAt? }} input
 * @returns {Promise<object>} the inserted row.
 */
async function recordInboundMessage({
  accountId, from, to, body, createdAt,
}) {
  const { rows } = await db.query(
    `INSERT INTO messages
       (account_id, direction, from_number, to_number, body, status, created_at)
     VALUES ($1, 'inbound', $2, $3, $4, 'received', COALESCE($5, NOW()))
     RETURNING *`,
    [accountId, from, to, body, createdAt || null],
  );
  logger.info({ accountId, from }, 'inbound message recorded (voicemail delivery)');
  return rows[0];
}

module.exports = {
  sendMessage,
  sendGroupMessage,
  handleInboundMessage,
  archiveInboundMedia,
  recordInboundMessage,
  getMessages,
  getConversation,
  fetchForAcrobits,
  updateMessageStatus,
  handleMessagingWebhook,
};
