/**
 * Telnyx integration — the ONLY module that talks to Telnyx
 * (CLAUDE.md: never call the voice/SMS vendor directly from routes/services
 * elsewhere). This replaces src/integrations/signalwire.js; the public function
 * signatures are kept identical so nothing above the integration layer changes.
 *
 * Wraps the Telnyx v2 REST API with Bearer auth and the mandated retry policy:
 * 3 retries with 1s / 2s / 4s exponential backoff. 4xx responses (client
 * errors, except 429) are not retried. When all retries are exhausted, we log,
 * emit an ops alert hook, and throw TELNYX_ERROR.
 *
 * Uses the global fetch from Node 20. The backoff base is read from
 * config.telnyx.retryBaseMs (default 1000) so tests can shrink it.
 */
const config = require('../config');
const { logger } = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

// Telnyx v2 REST base. Unlike SignalWire there is no per-customer space — every
// tenant shares api.telnyx.com and is scoped by the Bearer API key.
const BASE_URL = 'https://api.telnyx.com/v2';

// Backoff multipliers; actual delay = multiplier * retryBaseMs.
const BACKOFF_STEPS = [1, 2, 4];

function authHeader() {
  return `Bearer ${config.telnyx.apiKey}`;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function retryDelay(attempt) {
  const baseMs = config.telnyx.retryBaseMs || 1000;
  return BACKOFF_STEPS[attempt] * baseMs;
}

// Delay before (and between) the messaging sub-resource PATCH, which can lag a
// number purchase. Defaults to 2s; overridable via config so tests run fast.
function messagingReadyDelayMs() {
  const v = config.telnyx.messagingReadyDelayMs;
  return v === undefined || v === null ? 2000 : v;
}

/** Placeholder ops-alert hook (CLAUDE.md: "queue for ops alert"). */
function emitOpsAlert(detail) {
  // TODO: publish to SQS_NOTIFICATION_QUEUE_URL when the queue layer lands.
  logger.error({ ...detail, opsAlert: true }, 'Telnyx ops alert');
}

/**
 * Issue a Telnyx REST request with retry. Resolves the parsed JSON body
 * (or null for empty/204). Throws AppError('TELNYX_ERROR') on client errors
 * or after exhausting retries.
 */
async function request(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const init = {
    method,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  let lastDetail;
  // attempt 0 is the first try; attempts 1..3 are the retries.
  for (let attempt = 0; attempt <= BACKOFF_STEPS.length; attempt += 1) {
    let res;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(url, init);
    } catch (networkErr) {
      // Network/transport failure — retryable.
      lastDetail = { method, path, reason: networkErr.message };
      if (attempt < BACKOFF_STEPS.length) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelay(attempt));
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    if (res.ok) {
      if (res.status === 204) return null;
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    // Client errors (except 429) are not retryable — fail fast.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text().catch(() => '');
      logger.error({
        method, path, status: res.status, body: text,
      }, 'Telnyx client error');
      // Surface the upstream HTTP status (mapped responses are all 502) so
      // callers can react to specific upstream conditions — e.g. a 404 on a
      // sub-resource that is not yet ready right after a number purchase.
      const clientErr = new AppError(
        'TELNYX_ERROR',
        `Telnyx rejected ${method} ${path} (${res.status}).`,
        { status: 502 },
      );
      clientErr.upstreamStatus = res.status;
      // Attach the parsed Telnyx error body (when JSON) so callers can inspect
      // the structured `errors[]` — e.g. E911 USPS address suggestions (10015).
      let responseBody = null;
      if (text) {
        try {
          responseBody = JSON.parse(text);
        } catch (parseErr) {
          responseBody = null;
        }
      }
      clientErr.responseBody = responseBody;
      throw clientErr;
    }

    // 5xx or 429 — retryable.
    lastDetail = { method, path, status: res.status };
    if (attempt < BACKOFF_STEPS.length) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryDelay(attempt));
    }
  }

  emitOpsAlert(lastDetail);
  throw new AppError('TELNYX_ERROR', 'Telnyx request failed after retries.', { status: 502 });
}

/**
 * Telnyx wraps every resource in a top-level `data` envelope:
 *   { "data": { ... } }  or  { "data": [ ... ], "meta": { ... } }
 * Unwrap it so callers see the bare resource/array, mirroring how the old
 * SignalWire module already normalized `{ data: [...] }`.
 */
function unwrap(payload) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  return payload;
}

// --- Typed API surface (signatures match the former signalwire module) ---

/**
 * Search available numbers in an area code. Returns the raw results array, each
 * entry carrying a `number` field (mapped from Telnyx's `phone_number`) so the
 * callers' existing `r.number || r.e164` extraction keeps working.
 * @param {string} areaCode - 3-digit NPA (Telnyx: national_destination_code).
 * @param {object} [options]
 * @param {number} [options.maxResults=50] - cap on results.
 * @param {string} [options.contains] - digit pattern anywhere in the number.
 * @param {string} [options.startsWith] - digit pattern at the start.
 * @param {string} [options.endsWith] - digit pattern at the end.
 */
async function searchAvailableNumbers(areaCode, options = {}) {
  const {
    maxResults = 50, contains, startsWith, endsWith,
  } = options;

  // Telnyx uses bracketed filter params. URLSearchParams encodes the brackets,
  // which the Telnyx API accepts. Append the two repeated `features[]` entries
  // so we only ever get SMS- and voice-capable numbers.
  const params = new URLSearchParams();
  params.append('filter[national_destination_code]', areaCode);
  params.append('filter[country_code]', 'US');
  params.append('filter[features][]', 'sms');
  params.append('filter[features][]', 'voice');
  params.append('filter[limit]', String(maxResults));
  if (contains) params.append('filter[phone_number][contains]', contains);
  if (startsWith) params.append('filter[phone_number][starts_with]', startsWith);
  if (endsWith) params.append('filter[phone_number][ends_with]', endsWith);

  const data = unwrap(await request('GET', `/available_phone_numbers?${params.toString()}`));
  const list = Array.isArray(data) ? data : [];
  // Normalize Telnyx `phone_number` -> `number` for the layers above.
  return list.map((entry) => ({ ...entry, number: entry.phone_number || entry.number }));
}

/**
 * Purchase a phone number via a Telnyx number order. Returns a resource whose
 * `id` is the +E.164 number itself, because that is the identifier callers feed
 * into PATCH /phone_numbers/{id} for assignNumberToEndpoint / number management.
 *
 * DECISION: PATCH/GET/DELETE /v2/phone_numbers/{id} accepts the +E.164 number
 * directly in the path (per Telnyx docs). The `id` nested in a number order's
 * `phone_numbers[]` is the ORDER-LINE sub-resource id — a DIFFERENT resource
 * from the phone number — so using it on /phone_numbers/{id} returns 404 (the
 * original bug). The E.164 is also the only identifier we reliably have right
 * after ordering (the order is async), so we key off it.
 */
async function purchaseNumber(e164) {
  const order = unwrap(await request('POST', '/number_orders', {
    phone_numbers: [{ phone_number: e164 }],
  }));

  const phoneNumber = (order && Array.isArray(order.phone_numbers) && order.phone_numbers[0]) || {};
  const number = phoneNumber.phone_number || e164;
  return {
    ...order,
    ...phoneNumber,
    // id MUST be the E.164 (used as the /phone_numbers/{id} path param), not the
    // order id or the order-line phone_numbers[].id.
    id: number,
    number,
  };
}

// Per-number routing defaults — the live MobilityNet TeXML voice application +
// messaging profile. Read at call time (not module load) and overridable via
// config/env so suites that mock a minimal config don't break.
const DEFAULT_TEXML_VOICE_CONNECTION_ID = '2990188126548264846';
const DEFAULT_MESSAGING_PROFILE_ID = '40019ed1-1614-4b43-9fa1-2b2386aa810b';

/**
 * Look up the numeric phone-number RESOURCE id for an E.164 number via
 * GET /v2/phone_numbers?filter[phone_number]={e164}.
 *
 * Why this is needed: a number order returns only the (async) order id and the
 * order-line sub-resource id — NEITHER of which addresses /v2/phone_numbers/{id}
 * (using them 404s). The per-number voice/messaging/E911 sub-resources are keyed
 * by the phone number's own numeric id (e.g. "2990277475533063368"), which we
 * fetch by filtering on the E.164 once the order has landed in the account.
 *
 * @returns {Promise<string|null>} the numeric resource id, or null if not found.
 */
async function findPhoneNumberId(e164) {
  const params = new URLSearchParams();
  params.append('filter[phone_number]', e164);
  const data = unwrap(await request('GET', `/phone_numbers?${params.toString()}`));
  const list = Array.isArray(data) ? data : [];
  const match = list.find((n) => (n.phone_number || n.number) === e164) || list[0] || null;
  return (match && match.id) || null;
}

/**
 * Provision a freshly-purchased number for service: buy it, resolve its numeric
 * resource id, then route inbound voice to our TeXML application (so
 * POST/GET /v1/voice/inbound fires) and attach the messaging profile (so SMS/MMS
 * work). Returns the purchase resource whose `id` is the numeric RESOURCE id —
 * this id is stored as signalwire_sid and passed to enableE911 downstream.
 *
 * The voice/messaging settings are per-number sub-resources on Telnyx, keyed by
 * the numeric resource id (NOT the E.164 — the order-line id 404s and the bare
 * E.164 is not the canonical path key for these sub-resources):
 *   PATCH /phone_numbers/{id}/voice     { connection_id }
 *   PATCH /phone_numbers/{id}/messaging { messaging_profile_id }
 */
async function provisionPhoneNumber(e164) {
  const telnyxCfg = config.telnyx || {};
  const voiceConnectionId = telnyxCfg.texmlConnectionId || DEFAULT_TEXML_VOICE_CONNECTION_ID;
  const messagingProfileId = telnyxCfg.messagingProfileId || DEFAULT_MESSAGING_PROFILE_ID;

  const purchase = await purchaseNumber(e164);
  const e164Number = purchase.number || e164;

  // Resolve the numeric resource id; fall back to the E.164 path form only if
  // the number is not yet indexed (defensive — the PATCH would then behave as
  // before rather than blowing up on an undefined id).
  const resourceId = await findPhoneNumberId(e164Number);
  const numberId = resourceId || e164Number;

  await request('PATCH', `/phone_numbers/${numberId}/voice`, {
    connection_id: voiceConnectionId,
  });

  // The messaging sub-resource can lag the number purchase: a PATCH issued
  // immediately after the order can 404 even though /voice already succeeded.
  // Give it a beat, then retry once more on a 404 (other errors propagate).
  const patchMessaging = () => request('PATCH', `/phone_numbers/${numberId}/messaging`, {
    messaging_profile_id: messagingProfileId,
  });
  await sleep(messagingReadyDelayMs());
  try {
    await patchMessaging();
  } catch (err) {
    if (err && err.upstreamStatus === 404) {
      await sleep(messagingReadyDelayMs());
      await patchMessaging();
    } else {
      throw err;
    }
  }

  return {
    ...purchase,
    // The numeric resource id is what every downstream caller needs: it is
    // stored as dids.signalwire_sid and passed to enableE911 as phoneNumberId.
    id: numberId,
    number: e164Number,
    phoneE164: e164Number,
  };
}

/**
 * Update a phone number's settings. Used to register outbound CNAM (the
 * caller-ID name shown on the far end), which on Telnyx lives on the number's
 * `voice` sub-resource as a `cnam_listing` object. The sub-resource path is
 * keyed by the numeric resource id, so we resolve it from the E.164 first.
 * @param {string} e164
 * @param {{ cnam_listing_enabled?: boolean, caller_id_name_as?: string }} fields
 * @returns {Promise<object>} the updated voice sub-resource.
 */
async function updatePhoneNumber(e164, fields = {}) {
  const resourceId = await findPhoneNumberId(e164);
  const numberId = resourceId || e164;
  const body = {};
  if (fields.cnam_listing_enabled !== undefined || fields.caller_id_name_as !== undefined) {
    body.cnam_listing = {
      cnam_listing_enabled: Boolean(fields.cnam_listing_enabled),
      // PSTN CNAM is capped at 15 chars; callers pass an already-trimmed name.
      cnam_listing_details: fields.caller_id_name_as,
    };
  }
  return unwrap(await request('PATCH', `/phone_numbers/${numberId}/voice`, body));
}

/**
 * Create a SIP credential set on Telnyx. Telnyx auto-generates the SIP
 * username/password tied to TELNYX_SIP_CONNECTION_ID — the `password`/`callerId`
 * we receive are NOT sent (the connection's outbound caller ID governs that).
 * Returns { id, sip_username, sip_password, ... }.
 * DECISION: the supplied `password` is ignored by Telnyx (credentials are
 * vendor-generated). The layer above still generates and bcrypt-stores its own
 * password for the Acrobits XML; reconciling that with Telnyx's auto-generated
 * credential is a Phase-2 follow-up flagged here so it isn't silently lost.
 */
async function createSipEndpoint(params) {
  // params.password / params.callerId are accepted for signature parity with
  // the former SignalWire module but are NOT sent: Telnyx auto-generates the
  // SIP credentials and the connection governs the outbound caller ID.
  return unwrap(await request('POST', '/telephony_credentials', {
    connection_id: config.telnyx.sipConnectionId,
    name: params.username,
  }));
}

/**
 * Fetch an existing SIP credential. Telnyx returns the live sip_username and
 * sip_password on GET (the credential password is retrievable, not write-once),
 * which the provisioning flow uses to render the Acrobits XML/QR without ever
 * storing the plaintext (CLAUDE.md security rule #3).
 */
async function getSipEndpoint(sipEndpointId) {
  return unwrap(await request('GET', `/telephony_credentials/${sipEndpointId}`));
}

/**
 * Update a SIP credential. NB: Telnyx telephony credentials are vendor-generated
 * and their PASSWORD cannot be changed here — PATCH only accepts metadata
 * (name, connection_id, tags, expires_at). Kept for those metadata updates.
 */
async function updateSipEndpoint(sipEndpointId, fields) {
  return unwrap(await request('PATCH', `/telephony_credentials/${sipEndpointId}`, fields));
}

/** Delete a SIP credential (on account cancellation). */
async function deleteSipEndpoint(sipEndpointId) {
  return request('DELETE', `/telephony_credentials/${sipEndpointId}`);
}

// Telnyx address-suggestion `source.pointer` -> our address field name.
const E911_POINTER_TO_FIELD = {
  '/street_address': 'line1',
  '/extended_address': 'line2',
  '/locality': 'city',
  '/administrative_area': 'state',
  '/postal_code': 'zip',
  '/country_code': 'countryCode',
};

/** Build the Telnyx POST /addresses request body from our address fields. */
function e911AddressBody({
  firstName, lastName, line1, line2, city, state, zip, countryCode,
}) {
  return {
    first_name: firstName,
    last_name: lastName,
    street_address: line1,
    extended_address: line2 || '',
    locality: city,
    administrative_area: state,
    postal_code: zip,
    country_code: countryCode || 'US',
    address_book: true,
    business_name: 'MobilityNet Subscriber',
  };
}

/**
 * Extract USPS-normalized field corrections from a Telnyx 422 error body.
 * Telnyx flags a correctable address with errors of code "10015" (Suggestion);
 * each carries the corrected value in `detail` and the target field in
 * `source.pointer` (e.g. "/street_address" -> "6674 E 118TH CT"). Returns a
 * partial address ({ line1, city, ... }), or null when there are no suggestions.
 */
function extractE911Suggestions(responseBody) {
  const list = responseBody && Array.isArray(responseBody.errors) ? responseBody.errors : [];
  const corrections = {};
  list.forEach((e) => {
    if (!e || String(e.code) !== '10015') return;
    const field = E911_POINTER_TO_FIELD[e.source && e.source.pointer];
    if (field && e.detail !== undefined && e.detail !== null) {
      corrections[field] = e.detail;
    }
  });
  return Object.keys(corrections).length ? corrections : null;
}

/**
 * Create an emergency (E911) address in the Telnyx address book.
 *
 * Telnyx validates against USPS and rejects a near-miss with HTTP 422 carrying
 * suggestion errors (code "10015") that contain the normalized values. On that
 * response we merge the suggestions over the submitted address and retry ONCE;
 * any other error (or a still-failing retry) propagates.
 * Returns { addressId, status }.
 */
async function createE911Address(address) {
  try {
    const data = unwrap(await request('POST', '/addresses', e911AddressBody(address)));
    return { addressId: data && data.id, status: data && data.status };
  } catch (err) {
    const suggestions = err && err.upstreamStatus === 422
      ? extractE911Suggestions(err.responseBody)
      : null;
    if (!suggestions) throw err;

    logger.info(
      { fields: Object.keys(suggestions) },
      'retrying E911 address with Telnyx USPS suggestions',
    );
    const corrected = { ...address, ...suggestions };
    const data = unwrap(await request('POST', '/addresses', e911AddressBody(corrected)));
    return { addressId: data && data.id, status: data && data.status };
  }
}

/**
 * Enable emergency (E911) calling on a number, pointing it at an E911 address.
 * Returns { emergencyEnabled, emergencyStatus }.
 */
async function enableE911({ phoneNumberId, addressId }) {
  const data = unwrap(await request('PATCH', `/phone_numbers/${phoneNumberId}/voice`, {
    emergency_enabled: true,
    emergency_address_id: addressId,
  }));
  return {
    emergencyEnabled: !!(data && data.emergency_enabled),
    emergencyStatus: data && data.emergency_status,
  };
}

/**
 * Update a credential connection's outbound settings.
 * Used to clear a static outbound ANI override:
 *   updateConnectionOutbound(id, { ani_override_type: 'default' })
 * With ani_override_type 'default' the connection stops forcing one caller ID,
 * so each call's own caller ID (the customer's DID, sent by the dialer) passes
 * through on outbound.
 */
async function updateConnectionOutbound(connectionId, outbound) {
  return unwrap(await request('PATCH', `/credential_connections/${connectionId}`, { outbound }));
}

/**
 * Assign a purchased number (by id) to the SIP connection. Telnyx routes a
 * number to a SIP endpoint by attaching it to a connection, so we set
 * connection_id rather than an endpoint id.
 * DECISION: `sipEndpointId` is unused — Telnyx binds numbers to the connection
 * (TELNYX_SIP_CONNECTION_ID) the credential already belongs to, not to an
 * individual credential. Kept in the signature for drop-in compatibility.
 */
// eslint-disable-next-line no-unused-vars
async function assignNumberToEndpoint(numberSid, sipEndpointId) {
  return unwrap(await request('PATCH', `/phone_numbers/${numberSid}`, {
    connection_id: config.telnyx.sipConnectionId,
  }));
}

/**
 * Assign a number (by id) to a 10DLC/TCR messaging campaign.
 * DECISION: Telnyx models 10DLC assignment as its own resource. We POST the
 * number+campaign pairing to /phone_number_campaigns; the full Telnyx 10DLC
 * brand/campaign onboarding flow lands in Phase 2. Signature preserved so the
 * webhook completion path is unchanged.
 */
async function assignNumberToCampaign(numberSid, campaignId) {
  return unwrap(await request('POST', '/phone_number_campaigns', {
    phone_number: numberSid,
    campaign_id: campaignId,
  }));
}

/**
 * Submit a number port-in request as a Telnyx porting order.
 * DECISION: Telnyx porting orders use a richer schema than SignalWire's flat
 * payload; the full mapping is Phase-2 work. For now we forward the caller's
 * payload so the admin "retry failed port" path keeps functioning, and unwrap
 * the `data` envelope so `response.id` resolves.
 */
async function submitPort(payload) {
  return unwrap(await request('POST', '/porting_orders', payload));
}

/** Send an SMS via Telnyx Messaging. */
async function sendSms({ from, to, text }) {
  return unwrap(await request('POST', '/messages', {
    from,
    to,
    text,
    messaging_profile_id: config.telnyx.messagingProfileId,
  }));
}

/**
 * Send an SMS or MMS via Telnyx Messaging. MMS is just an SMS with media_urls.
 * @param {object} params
 * @param {string} params.from - sender E.164.
 * @param {string} params.to - recipient E.164.
 * @param {string} [params.body] - message text (may be empty for media-only MMS).
 * @param {string[]} [params.mediaUrls] - public media URLs (MMS).
 * @param {string} [params.messagingProfileId] - overrides the config default.
 * @returns {Promise<object>} the Telnyx message resource ({ id, to, from, ... }).
 */
async function sendMessage({
  from, to, body, mediaUrls, messagingProfileId,
}) {
  return unwrap(await request('POST', '/messages', {
    from,
    to,
    text: body || '',
    media_urls: mediaUrls || [],
    messaging_profile_id: messagingProfileId || config.telnyx.messagingProfileId,
  }));
}

/**
 * Fetch recordings for a call. Used by the voicemail hangup safety net: when a
 * caller hangs up mid-recording the <Record> action callback never fires, so we
 * pull any recording Telnyx captured for the call and process it.
 *
 * The TeXML CallSid arrives as `v3:xxx`. The colon URL-encodes to `%3A`, which
 * the direct `/calls/{id}/recordings` path rejects with a 404, and the `v3:`
 * prefix isn't what the Call Control API keys on either. So we try several
 * lookups in order and use the first that yields recordings, logging which one
 * worked so we can pin the correct approach for production:
 *   1. GET /recordings?filter[call_session_id]={callSid}
 *   2. GET /recordings?filter[call_leg_id]={callSid}
 *   3. GET /calls/{callSid without "v3:"}/recordings  (direct path)
 *
 * Returns the raw recordings array (empty when none exist). Each attempt is
 * isolated — a 404/error on one falls through to the next.
 * @param {string} callSid - the call identifier (Telnyx CallSid / call id).
 * @returns {Promise<object[]>}
 */
async function getCallRecordings(callSid) {
  const asArray = (data) => {
    if (Array.isArray(data)) return data;
    return data ? [data] : [];
  };

  const bare = String(callSid).replace(/^v3:/, '');
  const attempts = [
    { label: 'filter[call_session_id]', path: `/recordings?filter[call_session_id]=${encodeURIComponent(callSid)}` },
    { label: 'filter[call_leg_id]', path: `/recordings?filter[call_leg_id]=${encodeURIComponent(callSid)}` },
    { label: 'calls/{id}/recordings (v3: stripped)', path: `/calls/${encodeURIComponent(bare)}/recordings` },
  ];

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    let recordings;
    try {
      // eslint-disable-next-line no-await-in-loop
      recordings = asArray(unwrap(await request('GET', attempt.path)));
    } catch (err) {
      logger.warn(
        { callId: callSid, approach: attempt.label, err: err.message },
        'getCallRecordings attempt failed; trying next',
      );
      recordings = [];
    }
    if (recordings.length) {
      logger.info(
        { callId: callSid, approach: attempt.label, count: recordings.length },
        'getCallRecordings succeeded',
      );
      return recordings;
    }
  }

  logger.info({ callId: callSid }, 'getCallRecordings found no recordings for call');
  return [];
}

// Module-level cache for the webhook public key fetched from Telnyx. `null`
// means "not yet fetched"; '' means "fetch attempted and unavailable" (so we
// don't hammer the API on every webhook). A configured key always wins.
let cachedWebhookPublicKey = null;

/**
 * Resolve the Ed25519 public key used to verify inbound Telnyx webhooks.
 *
 * Order of preference:
 *   1. config.telnyx.webhookPublicKey (TELNYX_WEBHOOK_PUBLIC_KEY env) — explicit.
 *   2. GET /v2/public_key, fetched once and cached for the process lifetime.
 *
 * Returns the base64-encoded key string, or '' when none is available (e.g. dev
 * with no API key). Never throws — the caller treats '' as "skip verification".
 * @returns {Promise<string>}
 */
async function getWebhookPublicKey() {
  if (config.telnyx.webhookPublicKey) return config.telnyx.webhookPublicKey;
  if (cachedWebhookPublicKey !== null) return cachedWebhookPublicKey;
  try {
    const data = unwrap(await request('GET', '/public_key'));
    cachedWebhookPublicKey = (data && data.public_key) || '';
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to fetch Telnyx webhook public key');
    cachedWebhookPublicKey = '';
  }
  return cachedWebhookPublicKey;
}

/** Test seam: clear the cached public key so each test starts fresh. */
function resetWebhookPublicKeyCache() {
  cachedWebhookPublicKey = null;
}

module.exports = {
  searchAvailableNumbers,
  getWebhookPublicKey,
  resetWebhookPublicKeyCache,
  purchaseNumber,
  provisionPhoneNumber,
  updatePhoneNumber,
  createSipEndpoint,
  getSipEndpoint,
  updateSipEndpoint,
  deleteSipEndpoint,
  updateConnectionOutbound,
  createE911Address,
  enableE911,
  assignNumberToEndpoint,
  assignNumberToCampaign,
  submitPort,
  sendSms,
  sendMessage,
  getCallRecordings,
  // exposed for tests
  request,
};
