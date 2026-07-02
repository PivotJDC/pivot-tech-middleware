/**
 * Push service — Acrobits Cloud Softphone push notifications.
 *
 * Acrobits delivers messaging over HTTP web services, not SIP, so the app must
 * be woken to fetch new messages. The app reports its push tokens to us via the
 * Acrobits Push Token Reporter (registerToken); when an inbound message lands we
 * notify it through the Acrobits Push Notification Manager (PNM), which relays to
 * APNs/FCM.
 *
 * The app reports two tokens: one for incoming calls (VoIP) and one for "other"
 * (messages). Message pushes use the "other" token + app id.
 *
 * sendMessagePush is best-effort: it never throws, so a push failure can't break
 * inbound message storage.
 */
const db = require('../db');
const { errors } = require('../middleware/errorHandler');
const { logger } = require('../utils/logger');

// Acrobits Push Notification Manager (Modern push). The verb tells the app what
// happened; "NotifyTextMessage" prompts it to run its message fetch.
const PNM_URL = 'https://pnm.cloudsoftphone.com/pnm2/send';

// Trim message previews so we never ship a huge push payload.
const PREVIEW_MAX = 100;

/**
 * Register (or update) an account's Acrobits push tokens, keyed by selector.
 * @param {string} accountId
 * @param {string} tenantId - the owning tenant (accounts.tenant_id).
 * @param {{ selector, pushTokenCalls?, pushTokenOther?, pushAppIdCalls?,
 *           pushAppIdOther?, deviceId?, platform? }} input
 * @returns {Promise<object>} the persisted push_tokens row.
 */
async function registerToken(accountId, tenantId, input = {}) {
  const {
    selector, pushTokenCalls, pushTokenOther,
    pushAppIdCalls, pushAppIdOther, deviceId, platform,
  } = input;
  if (!selector) throw errors.validation('selector is required.', 'selector');
  if (!tenantId) throw errors.validation('tenant is required.', 'tenant_id');

  const { rows } = await db.query(
    `INSERT INTO push_tokens
       (account_id, tenant_id, selector, push_token_calls, push_token_other,
        push_app_id_calls, push_app_id_other, device_id, platform)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (account_id, selector)
     DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       push_token_calls = EXCLUDED.push_token_calls,
       push_token_other = EXCLUDED.push_token_other,
       push_app_id_calls = EXCLUDED.push_app_id_calls,
       push_app_id_other = EXCLUDED.push_app_id_other,
       device_id = EXCLUDED.device_id,
       platform = EXCLUDED.platform,
       updated_at = NOW()
     RETURNING *`,
    [
      accountId, tenantId, selector,
      pushTokenCalls || null, pushTokenOther || null,
      pushAppIdCalls || null, pushAppIdOther || null,
      deviceId || null, platform || null,
    ],
  );
  logger.info({ accountId, selector }, 'push token registered');
  return rows[0];
}

/**
 * Notify an account's device(s) of a new inbound message via the Acrobits PNM.
 * Best-effort: sends to every registered "other" token and swallows all errors.
 * @param {string} accountId
 * @param {{ from?: string, body?: string, messageId?: string, streamId?: string }} message
 * @returns {Promise<{ sent: number }>}
 */
async function sendMessagePush(accountId, message = {}) {
  const {
    from, body, messageId, streamId,
  } = message;
  try {
    const { rows } = await db.query(
      'SELECT * FROM push_tokens WHERE account_id = $1',
      [accountId],
    );
    if (rows.length === 0) {
      logger.info({ accountId }, 'no push token registered; skipping notification');
      return { sent: 0 };
    }

    const results = await Promise.all(rows.map((token) => fetch(PNM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verb: 'NotifyTextMessage',
        AppId: token.push_app_id_other,
        DeviceToken: token.push_token_other,
        Selector: token.selector,
        Badge: 1,
        Sound: 'default',
        UserName: from,
        Message: String(body || '').substring(0, PREVIEW_MAX),
        ContentType: 'text/plain',
        Id: messageId,
        ThreadId: streamId,
      }),
    }).then(() => true).catch((err) => {
      logger.warn({ accountId, err: err.message }, 'push notification send failed');
      return false;
    })));

    const sent = results.filter(Boolean).length;
    logger.info({ accountId, messageId, sent }, 'message push notification dispatched');
    return { sent };
  } catch (err) {
    logger.warn({ accountId, err: err.message }, 'push notification lookup failed');
    return { sent: 0 };
  }
}

module.exports = { registerToken, sendMessagePush };
