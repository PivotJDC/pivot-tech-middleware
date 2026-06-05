/**
 * DID orchestration — the SignalWire side of provisioning a new line.
 *
 * assignDid() runs the full assignment sequence against SignalWire and returns
 * the resulting credentials. It performs NO database writes; the caller
 * (accountService) persists the account + did rows transactionally. Keeping all
 * the external side effects here, before any DB write, means a SignalWire
 * failure never leaves a half-written account.
 *
 * Sequence: pick area code (by market) -> search available numbers -> purchase
 * -> create SIP endpoint -> assign number to endpoint -> return credentials.
 */
const nodeCrypto = require('crypto');
const signalwire = require('../integrations/signalwire');
const crypto = require('../utils/crypto');
const { logger } = require('../utils/logger');
const { errors, AppError } = require('../middleware/errorHandler');
const MARKET_AREA_CODES = require('../config/markets');

/** Pull the e164 string off a SignalWire search/number resource. */
function numberOf(resource) {
  return resource.number || resource.e164;
}

/** Pull the id/sid off a SignalWire resource. */
function idOf(resource) {
  return resource.id || resource.sid;
}

/**
 * Find the first available number across a market's configured area codes.
 * @returns {Promise<{ e164: string, areaCode: string }>}
 */
async function findAvailableNumber(market) {
  const areaCodes = MARKET_AREA_CODES[market];
  if (!areaCodes || areaCodes.length === 0) {
    throw errors.validation(`No area codes configured for market: ${market}.`, 'market');
  }

  // Try each area code in order; sequential by design (stop at first hit).
  for (let i = 0; i < areaCodes.length; i += 1) {
    const areaCode = areaCodes[i];
    // eslint-disable-next-line no-await-in-loop
    const results = await signalwire.searchAvailableNumbers(areaCode);
    if (results.length > 0) {
      return { e164: numberOf(results[0]), areaCode };
    }
  }

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
async function assignDid(market) {
  const { e164, areaCode } = await findAvailableNumber(market);

  const purchase = await signalwire.purchaseNumber(e164);
  const signalwireSid = idOf(purchase);

  const sipUsername = `pivottech-${nodeCrypto.randomUUID()}`;
  const sipPassword = crypto.randomSecret();
  const endpoint = await signalwire.createSipEndpoint({
    username: sipUsername,
    password: sipPassword,
    callerId: e164,
  });
  const sipEndpointId = idOf(endpoint);

  await signalwire.assignNumberToEndpoint(signalwireSid, sipEndpointId);

  // Never log sipPassword (CLAUDE.md security rule #1).
  logger.info({
    market, areaCode, phoneE164: e164, sipEndpointId,
  }, 'DID assigned on SignalWire');

  return {
    phoneE164: e164, areaCode, signalwireSid, sipUsername, sipEndpointId, sipPassword,
  };
}

/**
 * Rotate the SIP endpoint's password and return the new plaintext. Used at
 * provisioning time so plaintext exists only in memory + the XML response.
 * @returns {Promise<string>} the new plaintext password
 */
async function rotateSipPassword(sipEndpointId) {
  const sipPassword = crypto.randomSecret();
  await signalwire.updateSipEndpoint(sipEndpointId, { password: sipPassword });
  return sipPassword;
}

module.exports = {
  assignDid,
  rotateSipPassword,
  findAvailableNumber,
};
