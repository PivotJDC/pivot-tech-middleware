/**
 * Push service — Acrobits Cloud Softphone push notifications.
 *
 * Acrobits delivers messaging over HTTP web services, not SIP, so the app must
 * be woken to fetch new messages. The app registers its push token with us
 * (registerToken), and when an inbound message lands we notify it via the
 * Acrobits Push Notification Manager (PNM), which relays to APNs/FCM.
 *
 * sendMessageNotification is best-effort: it never throws, so a push failure
 * can't break inbound message storage.
 */
const db = require('../db');
const { errors } = require('../middleware/errorHandler');
const { logger } = require('../utils/logger');

// Acrobits Push Notification Manager (Modern push). The verb tells the app what
// happened; "NotifyTextMessage" prompts it to run its message fetch.
const PNM_URL = 'https://pnm.cloudsoftphone.com/pnm2/send';

/**
 * Register (or update) an Acrobits push token for a device.
 * @param {string} accountId
 * @param {{ deviceToken, selector?, appId, platform, deviceId? }} input
 * @returns {Promise<object>} the persisted push_tokens row.
 */
async function registerToken(accountId, input = {}) {
  const {
    deviceToken, selector, appId, platform, deviceId,
  } = input;
  if (!deviceToken) throw errors.validation('device_token is required.', 'device_token');
  if (!appId) throw errors.validation('app_id is required.', 'app_id');
  if (!platform) throw errors.validation('platform is required.', 'platform');

  const { rows } = await db.query(
    `INSERT INTO push_tokens (account_id, device_token, selector, app_id, platform, device_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id, device_id)
     DO UPDATE SET
       device_token = EXCLUDED.device_token,
       selector = EXCLUDED.selector,
       app_id = EXCLUDED.app_id,
       platform = EXCLUDED.platform,
       updated_at = NOW()
     RETURNING *`,
    [accountId, deviceToken, selector || null, appId, platform, deviceId || null],
  );
  logger.info({ accountId, platform, deviceId: deviceId || null }, 'push token registered');
  return rows[0];
}

/**
 * Wake an account's device(s) so the app fetches a new message. Best-effort:
 * sends to every registered token and swallows all errors.
 * @param {string} accountId
 * @param {object} message - the stored message row (for logging context).
 * @returns {Promise<{ sent: number }>}
 */
async function sendMessageNotification(accountId, message) {
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
        DeviceToken: token.device_token,
        Selector: token.selector,
        AppId: token.app_id,
        verb: 'NotifyTextMessage',
      }),
    }).then(() => true).catch((err) => {
      logger.warn({ accountId, err: err.message }, 'push notification send failed');
      return false;
    })));

    const sent = results.filter(Boolean).length;
    logger.info(
      { accountId, messageId: message && message.id, sent },
      'message push notification dispatched',
    );
    return { sent };
  } catch (err) {
    logger.warn({ accountId, err: err.message }, 'push notification lookup failed');
    return { sent: 0 };
  }
}

module.exports = { registerToken, sendMessageNotification };
