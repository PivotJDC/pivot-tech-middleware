/**
 * Voice service — inbound call routing lookups.
 *
 * Telnyx routes inbound PSTN calls to our TeXML webhook; we answer with a TeXML
 * document that bridges the call to the subscriber's registered SIP credential.
 * This module owns the account lookup the webhook needs. It never touches HTTP.
 */
const db = require('../db');

/**
 * Resolve the account that owns a called MobilityNet number.
 * @param {string} e164 - the dialed number (the TeXML `To`).
 * @returns {Promise<{ account_id: string, sip_username: string, status: string }|null>}
 *   the match (including status so the caller can require 'active'), or null.
 */
async function lookupByCalledNumber(e164) {
  if (!e164) return null;
  const { rows } = await db.query(
    'SELECT id, sip_username, status FROM accounts WHERE phone_e164 = $1',
    [e164],
  );
  if (rows.length === 0) return null;
  return {
    account_id: rows[0].id,
    sip_username: rows[0].sip_username,
    status: rows[0].status,
  };
}

module.exports = { lookupByCalledNumber };
