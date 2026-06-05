/**
 * Notification service — STUB.
 *
 * APNs/FCM credentials are not wired up yet, so this logs what it would send
 * and resolves successfully. That lets the webhook handler run end to end today;
 * swapping in real push delivery later is a drop-in replacement for notify().
 *
 * When implemented, this will send VoIP/standard push via APNs (config.apns)
 * and FCM (config.fcm). Never include secrets or full PII in the payload that
 * reaches the logs.
 */
const { logger } = require('../utils/logger');

/**
 * Notify a customer of an event.
 * @param {{ id?: string }} account - the target account
 * @param {string} event - event key, e.g. 'port.completed'
 * @param {object} [data] - non-sensitive context for the message
 * @returns {Promise<{ stubbed: true, event: string }>}
 */
async function notify(account, event, data = {}) {
  logger.info(
    {
      accountId: account && account.id, event, data, channel: 'apns+fcm',
    },
    'notification stub: would send push',
  );
  return { stubbed: true, event };
}

module.exports = { notify };
