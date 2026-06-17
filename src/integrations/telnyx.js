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
      throw new AppError('TELNYX_ERROR', `Telnyx rejected ${method} ${path} (${res.status}).`, { status: 502 });
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

  // TEMP DEBUG (remove once the prod number-order shape is confirmed): log the
  // full order response so we can verify the phone_numbers[] structure/ids.
  logger.info({ telnyxNumberOrder: order }, 'Telnyx number order response');

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

module.exports = {
  searchAvailableNumbers,
  purchaseNumber,
  createSipEndpoint,
  getSipEndpoint,
  updateSipEndpoint,
  deleteSipEndpoint,
  assignNumberToEndpoint,
  assignNumberToCampaign,
  submitPort,
  sendSms,
  // exposed for tests
  request,
};
