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
const config = require('../config');
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
    let results = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      results = await telnyx.searchAvailableNumbers(areaCode);
    } catch (err) {
      // A Telnyx 4xx (e.g. 400 for an area code with no orderable inventory) is
      // NOT an outage — treat it as "none available" for this area code and try
      // the next one, so a bad area code never surfaces a raw 502 to the signup
      // flow. A 5xx / network failure (no 4xx upstreamStatus) is a genuine error
      // and propagates as TELNYX_ERROR.
      if (err && err.upstreamStatus >= 400 && err.upstreamStatus < 500) {
        logger.warn(
          { market, areaCode, upstreamStatus: err.upstreamStatus },
          `Telnyx rejected the number search for area code ${areaCode} (${err.upstreamStatus}); treating as no inventory`,
        );
      } else {
        throw err;
      }
    }
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

  // Every area code came up empty (or was rejected): log loudly with the full
  // list tried so the CloudWatch line alone tells ops what to replenish, then
  // surface a friendly, area-code-specific error — never the raw Telnyx message.
  logger.error(
    { code: 'DID_UNAVAILABLE', market, areaCodesTried: areaCodes },
    `DID_UNAVAILABLE: no numbers available for market ${market} after trying area codes ${areaCodes.join(', ')}`,
  );
  const message = areaCodes.length === 1
    ? `No numbers available in area code ${areaCodes[0]}. Please try a different area code.`
    : `No numbers available in area codes ${areaCodes.join(', ')}. Please try a different area code.`;
  throw new AppError('DID_UNAVAILABLE', message, { field: 'area_code' });
}

/**
 * Assign a DID + SIP endpoint for a new account in the given market. When an
 * enrollment serviceAddress is supplied, also provisions E911 (best-effort).
 *
 * When `requestedNumber` is supplied (the customer chose a specific number),
 * that EXACT number is purchased — we never silently substitute a different one
 * from the area code. If it's no longer available, a DID_UNAVAILABLE error is
 * raised so the customer can pick another. Only when no number is specified do
 * we auto-select the first available number in the market.
 * @param {string} market
 * @param {string|null} [requestedAreaCode]
 * @param {{ firstName?, lastName?, serviceAddress?: object }} [enrollment]
 * @param {string|null} [requestedNumber] - exact customer-selected E.164.
 * @returns {Promise<{
 *   phoneE164: string, areaCode: string, signalwireSid: string,
 *   sipUsername: string, sipEndpointId: string, sipPassword: string,
 *   e911AddressId: string|null, e911Enabled: boolean
 * }>}
 */
async function assignDid(
  market,
  requestedAreaCode = null,
  enrollment = {},
  requestedNumber = null,
) {
  // Purchase + route inbound voice to the TeXML app + attach the messaging
  // profile (so inbound calls hit /v1/voice/inbound and SMS/MMS work).
  let e164;
  let areaCode;
  let purchase;
  if (requestedNumber) {
    // Customer picked a specific number — buy THAT exact number, no fallback.
    e164 = requestedNumber;
    areaCode = requestedAreaCode;
    try {
      purchase = await telnyx.provisionPhoneNumber(e164);
    } catch (err) {
      // A Telnyx 4xx (404 / not available / already taken) means the number
      // was claimed between selection and checkout. Surface a clear, actionable
      // error instead of substituting a different number.
      if (err && err.upstreamStatus >= 400 && err.upstreamStatus < 500) {
        logger.warn(
          { requestedNumber, upstreamStatus: err.upstreamStatus },
          'customer-selected number no longer available at Telnyx',
        );
        throw new AppError(
          'DID_UNAVAILABLE',
          'The number you selected is no longer available. Please go back and choose a different number.',
          { field: 'phone_e164' },
        );
      }
      throw err;
    }
  } else {
    // No specific number — auto-select the first available in the market.
    ({ e164, areaCode } = await findAvailableNumber(market, requestedAreaCode));
    purchase = await telnyx.provisionPhoneNumber(e164);
  }
  const signalwireSid = idOf(purchase);

  // Attach the outbound voice profile to the DID. NOTE: this may be redundant now
  // that caller ID is set via the Account XML <userCallerId> (SIP From header) —
  // kept as belt-and-suspenders for the outbound SIP path; safe to remove once
  // confirmed unnecessary in production.
  await telnyx.updatePhoneNumber(e164, {
    outbound_voice_profile_id: config.telnyx.outboundVoiceProfileId,
  });
  logger.info({ phoneE164: e164 }, 'attached outbound voice profile to DID');

  // Telnyx auto-generates the SIP credentials; we only supply a recognizable
  // name for the Telnyx portal. The POST response may NOT include the real
  // sip_username (it can echo the `name`), so we GET the credential afterward to
  // read the actual gencred username/password Telnyx assigned.
  const credentialName = `pivottech-${nodeCrypto.randomUUID()}`;
  const created = await telnyx.createSipEndpoint({
    username: credentialName,
    callerId: e164,
  });
  logger.info({
    postName: created.name,
    postSipUsername: created.sip_username,
    postKeys: Object.keys(created || {}),
  }, 'Telnyx credential POST response');
  const sipEndpointId = idOf(created);
  const endpoint = await telnyx.getSipEndpoint(sipEndpointId);
  const sipUsername = endpoint.sip_username;
  const sipPassword = endpoint.sip_password;
  logger.info({ sipEndpointId, name: credentialName, sipUsername }, 'fetched Telnyx SIP credential');

  // Do NOT assign the number to the SIP connection here: provisionPhoneNumber
  // already pointed the number's voice connection at the TeXML app (for inbound
  // call routing). Assigning the SIP connection (assignNumberToEndpoint) would
  // overwrite that connection_id and break inbound calls. Outbound calls route
  // via the SIP credential's own connection, not the number's connection_id.

  // Best-effort E911: register the subscriber's service address and enable
  // emergency calling on the number. Like BICS, a failure here is logged but
  // never fails account creation.
  let e911AddressId = null;
  let e911Enabled = false;
  const svc = enrollment.serviceAddress;
  if (svc && svc.line1) {
    try {
      const addr = await telnyx.createE911Address({
        firstName: enrollment.firstName,
        lastName: enrollment.lastName,
        line1: svc.line1,
        line2: svc.line2,
        city: svc.city,
        state: svc.state,
        zip: svc.zip,
      });
      e911AddressId = addr.addressId || null;
      if (e911AddressId) {
        const result = await telnyx.enableE911({
          phoneNumberId: signalwireSid,
          addressId: e911AddressId,
        });
        e911Enabled = !!result.emergencyEnabled;
      }
    } catch (err) {
      logger.error({ phoneE164: e164, err: err.message }, 'E911 provisioning failed (best-effort)');
    }
  }

  // Best-effort CNAM: register the outbound caller-ID name (the name shown on
  // the far end). PSTN CNAM is capped at 15 characters; fall back to the brand
  // name when we don't have a full subscriber name. A failure here never fails
  // account creation.
  const { firstName, lastName } = enrollment;
  try {
    await telnyx.updatePhoneNumber(e164, {
      cnam_listing_enabled: true,
      caller_id_name_as: firstName && lastName
        ? `${firstName} ${lastName}`.substring(0, 15)
        : 'MobilityNet',
    });
    logger.info({ phoneE164: e164 }, 'CNAM registered on Telnyx');
  } catch (err) {
    logger.error({ phoneE164: e164, err: err.message }, 'CNAM registration failed (best-effort)');
  }

  // Never log sipPassword (CLAUDE.md security rule #1).
  logger.info({
    market, areaCode, phoneE164: e164, sipEndpointId, e911Enabled,
  }, 'DID assigned on Telnyx');

  return {
    phoneE164: e164,
    areaCode,
    signalwireSid,
    sipUsername,
    sipEndpointId,
    sipPassword,
    e911AddressId,
    e911Enabled,
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

/**
 * Fetch the live SIP credential (gencred username + plaintext password) straight
 * from Telnyx. Used to build the provisioning QR without depending on a possibly
 * stale stored sip_username. Plaintext stays in memory only for the caller.
 * @returns {Promise<{ sip_username: string, sip_password: string }>}
 */
async function getSipCredential(sipEndpointId) {
  const credential = await telnyx.getSipEndpoint(sipEndpointId);
  return {
    sip_username: credential.sip_username,
    sip_password: credential.sip_password,
  };
}

module.exports = {
  assignDid,
  getSipPassword,
  getSipCredential,
  findAvailableNumber,
};
