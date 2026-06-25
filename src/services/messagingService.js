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
const accountService = require('./accountService');
const { errors } = require('../middleware/errorHandler');
const { logger } = require('../utils/logger');

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

  const account = await db.query(
    'SELECT id FROM accounts WHERE phone_e164 = $1',
    [to],
  );
  if (account.rows.length === 0) {
    logger.warn({ to, telnyxMessageId }, 'inbound message for unknown number; ignored');
    return null;
  }
  const accountId = account.rows[0].id;

  const { rows } = await db.query(
    `INSERT INTO messages
       (account_id, direction, from_number, to_number, body, media_urls,
        telnyx_message_id, status)
     VALUES ($1, 'inbound', $2, $3, $4, $5, $6, 'received')
     RETURNING *`,
    [accountId, from, to, body, mediaUrls, telnyxMessageId],
  );
  logger.info({ accountId, telnyxMessageId }, 'inbound message stored');
  // TODO: send a push notification (APNs/FCM) to the device for this account.
  return rows[0];
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

module.exports = {
  sendMessage,
  handleInboundMessage,
  getMessages,
  getConversation,
  updateMessageStatus,
  handleMessagingWebhook,
};
