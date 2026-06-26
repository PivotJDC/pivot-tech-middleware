/**
 * DID orchestration — the Telnyx side of provisioning a new line.
 *
 * assignDid() runs the full assignment sequence against Telnyx and returns
 * the resulting credentials. It performs NO database writes; the caller
 * (accountService) persists the account + did rows transactionally. Keeping all
 * the external side effects here, before any DB write, means a Telnyx
 * failure never leaves a half-written account.
 *
 * Sequence: pick area code (by market) -> search available numbers -> purchase
 * -> create SIP endpoint -> assign number to endpoint -> return credentials.
 */
const nodeCrypto = require('crypto');
const telnyx = require('../integrations/telnyx');
const { logger } = require('../utils/logger');
const { errors, AppError } = require('../middleware/errorHandler');
const MARKET_AREA_CODES = require('../config/markets');

/** Pull the e164 string off a Telnyx search/number resource. */
function numberOf(resource) {
  return resource.number || resource.e164;
}

/** Pull the id/sid off a Telnyx resource. */
function idOf(resource) {
  return resource.id || resource.sid;
}

/**
 * Find the first available number for a market.
 * - Launched markets use their configured area codes (in order).
 * - "direct"/unlaunched markets (no config) search the requestedAreaCode, so a
 *   customer can pick any US area code.
 * @param {string} market
 * @param {string|null} [requestedAreaCode] - area code to search for direct markets.
 * @returns {Promise<{ e164: string, areaCode: string }>}
 */
async function findAvailableNumber(market, requestedAreaCode = null) {
  let areaCodes = MARKET_AREA_CODES[market];
  if (!areaCodes || areaCodes.length === 0) {
    // Not a launched market — search the requested area code as-is.
    if (requestedAreaCode) {
      areaCodes = [requestedAreaCode];
    } else {
      throw errors.validation(
        `No area code available for market "${market}". Provide a phone number or a launched market.`,
        'market',
      );
    }
  }

  // Try each area code in order; sequential by design (stop at first hit).
  for (let i = 0; i < areaCodes.length; i += 1) {
    const areaCode = areaCodes[i];
    // eslint-disable-next-line no-await-in-loop
    const results = await telnyx.searchAvailableNumbers(areaCode);
    if (results.length > 0) {
      // Surface when we landed on a fallback — a market whose primary area
      // code keeps coming up dry is an inventory signal ops should see.
      if (i > 0) {
        logger.warn(
          { market, areaCode, exhausted: areaCodes.slice(0, i) },
          `no DIDs in primary area code(s) ${areaCodes.slice(0, i).join(', ')} for market ${market}; using fallback ${areaCode}`,
        );
      }
      return { e164: numberOf(results[0]), areaCode };
    }
    logger.warn(
      { market, areaCode },
      `no DIDs available in area code ${areaCode} for market ${market}`,
    );
  }

  // Every configured area code came up empty: log loudly with the full list
  // tried so the CloudWatch line alone tells ops what to replenish.
  logger.error(
    { code: 'DID_UNAVAILABLE', market, areaCodesTried: areaCodes },
    `DID_UNAVAILABLE: no numbers available for market ${market} after trying area codes ${areaCodes.join(', ')}`,
  );
  throw new AppError(
    'DID_UNAVAILABLE',
    `No numbers available for market ${market} (area codes ${areaCodes.join(', ')}).`,
    { field: 'market' },
  );
}

/**
 * Assign a DID + SIP endpoint for a new account in the given market.
 * @returns {Promise<{
 *   phoneE164: string, areaCode: string, signalwireSid: string,
 *   sipUsername: string, sipEndpointId: string, sipPassword: string
 * }>}
 */
async function assignDid(market, requestedAreaCode = null) {
  const { e164, areaCode } = await findAvailableNumber(market, requestedAreaCode);

  // Purchase + route inbound voice to the TeXML app + attach the messaging
  // profile (so inbound calls hit /v1/voice/inbound and SMS/MMS work).
  const purchase = await telnyx.provisionPhoneNumber(e164);
  const signalwireSid = idOf(purchase);

  // Telnyx auto-generates the SIP credentials; we only supply a recognizable
  // name for the Telnyx portal. The credential's real sip_username/sip_password
  // come back in the create response and are what the account actually uses —
  // we must NOT substitute our own generated values (they wouldn't authenticate).
  const credentialName = `pivottech-${nodeCrypto.randomUUID()}`;
  const endpoint = await telnyx.createSipEndpoint({
    username: credentialName,
    callerId: e164,
  });
  const sipEndpointId = idOf(endpoint);
  const sipUsername = endpoint.sip_username;
  const sipPassword = endpoint.sip_password;

  // Do NOT assign the number to the SIP connection here: provisionPhoneNumber
  // already pointed the number's voice connection at the TeXML app (for inbound
  // call routing). Assigning the SIP connection (assignNumberToEndpoint) would
  // overwrite that connection_id and break inbound calls. Outbound calls route
  // via the SIP credential's own connection, not the number's connection_id.

  // Never log sipPassword (CLAUDE.md security rule #1).
  logger.info({
    market, areaCode, phoneE164: e164, sipEndpointId,
  }, 'DID assigned on Telnyx');

  return {
    phoneE164: e164, areaCode, signalwireSid, sipUsername, sipEndpointId, sipPassword,
  };
}

/**
 * Return the SIP endpoint's current plaintext password for provisioning.
 *
 * DECISION (Telnyx migration): Telnyx telephony credentials are vendor-generated
 * and their password CANNOT be rotated — PATCH /telephony_credentials/{id} only
 * updates metadata (name/connection_id/tags/expiry). So we no longer rotate at
 * provisioning time; instead we fetch the existing credential (Telnyx returns
 * sip_password on GET) and return it. The plaintext exists only in memory while
 * the caller renders the Acrobits XML/QR, satisfying CLAUDE.md security rule #3
 * without ever storing a recoverable copy.
 *
 * Formerly named rotateSipPassword; renamed because it no longer rotates.
 * @returns {Promise<string>} the credential's current plaintext password
 */
async function getSipPassword(sipEndpointId) {
  logger.warn(
    { sipEndpointId },
    'Telnyx SIP credential passwords cannot be rotated; using the existing credential',
  );
  const credential = await telnyx.getSipEndpoint(sipEndpointId);
  return credential.sip_password;
}

module.exports = {
  assignDid,
  getSipPassword,
  findAvailableNumber,
};
