/**
 * SignalWire integration — the ONLY module that talks to SignalWire
 * (CLAUDE.md: never call SignalWire directly from routes/services elsewhere).
 *
 * Wraps the REST API with HTTP Basic auth and the mandated retry policy:
 * 3 retries with 1s / 2s / 4s exponential backoff. 4xx responses (client
 * errors) are not retried. When all retries are exhausted, we log, emit an ops
 * alert hook, and throw SIGNALWIRE_ERROR.
 *
 * Uses the global fetch from Node 20. The backoff base is read from
 * config.signalwire.retryBaseMs (default 1000) so tests can shrink it.
 */
const config = require('../config');
const { logger } = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

// Backoff multipliers; actual delay = multiplier * retryBaseMs.
const BACKOFF_STEPS = [1, 2, 4];

function baseUrl() {
  return `https://${config.signalwire.space}.signalwire.com`;
}

function authHeader() {
  const creds = `${config.signalwire.projectId}:${config.signalwire.apiToken}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function retryDelay(attempt) {
  const baseMs = config.signalwire.retryBaseMs || 1000;
  return BACKOFF_STEPS[attempt] * baseMs;
}

/** Placeholder ops-alert hook (CLAUDE.md: "queue for ops alert"). */
function emitOpsAlert(detail) {
  // TODO: publish to SQS_NOTIFICATION_QUEUE_URL when the queue layer lands.
  logger.error({ ...detail, opsAlert: true }, 'SignalWire ops alert');
}

/**
 * Issue a SignalWire REST request with retry. Resolves the parsed JSON body
 * (or null for empty/204). Throws AppError('SIGNALWIRE_ERROR') on client errors
 * or after exhausting retries.
 */
async function request(method, path, body) {
  const url = `${baseUrl()}${path}`;
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
      }, 'SignalWire client error');
      throw new AppError('SIGNALWIRE_ERROR', `SignalWire rejected ${method} ${path} (${res.status}).`, { status: 502 });
    }

    // 5xx or 429 — retryable.
    lastDetail = { method, path, status: res.status };
    if (attempt < BACKOFF_STEPS.length) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryDelay(attempt));
    }
  }

  emitOpsAlert(lastDetail);
  throw new AppError('SIGNALWIRE_ERROR', 'SignalWire request failed after retries.', { status: 502 });
}

// --- Typed API surface (CLAUDE.md "Key API calls needed") ---

/**
 * Search available numbers in an area code. Returns the raw results array.
 * @param {string} areaCode - 3-digit NPA.
 * @param {object} [options]
 * @param {number} [options.maxResults=5] - cap on results (SignalWire max 100).
 * @param {string} [options.contains] - 3-7 digit pattern anywhere in the number.
 * @param {string} [options.startsWith] - 3-7 digit pattern at the start.
 * @param {string} [options.endsWith] - 3-7 digit pattern at the end.
 */
async function searchAvailableNumbers(areaCode, options = {}) {
  const {
    maxResults = 5, contains, startsWith, endsWith,
  } = options;
  // NB: the documented param is `areacode` (no underscore) — `area_code` is
  // silently ignored and returns numbers from any region. URLSearchParams keeps
  // areacode first and handles encoding.
  const params = new URLSearchParams({
    areacode: areaCode,
    max_results: String(maxResults),
  });
  if (contains) params.set('contains', contains);
  if (startsWith) params.set('starts_with', startsWith);
  if (endsWith) params.set('ends_with', endsWith);

  const data = await request('GET', `/api/relay/rest/phone_numbers/search?${params.toString()}`);
  // SignalWire returns { data: [ { number, ... } ] } or an array; normalize.
  if (Array.isArray(data)) return data;
  return (data && data.data) || [];
}

/** Purchase a phone number. Returns the created number resource (incl. id/sid). */
async function purchaseNumber(e164) {
  return request('POST', '/api/relay/rest/phone_numbers', { number: e164 });
}

/** Create a SIP endpoint. Returns the created endpoint resource (incl. id). */
async function createSipEndpoint({ username, password, callerId }) {
  return request('POST', '/api/relay/rest/endpoints/sip', {
    username,
    password,
    caller_id: callerId,
    encryption: 'required',
    codecs: ['OPUS', 'PCMU'],
  });
}

/** Assign a purchased number (by sid) to a SIP endpoint. */
async function assignNumberToEndpoint(numberSid, sipEndpointId) {
  return request('PUT', `/api/relay/rest/phone_numbers/${numberSid}`, {
    sip_endpoint_id: sipEndpointId,
  });
}

/** Update a SIP endpoint — used to rotate the password at provisioning time. */
async function updateSipEndpoint(sipEndpointId, fields) {
  return request('PUT', `/api/relay/rest/endpoints/sip/${sipEndpointId}`, fields);
}

/** Assign a number (by sid) to a 10DLC/TCR messaging campaign. */
async function assignNumberToCampaign(numberSid, campaignId) {
  return request('PUT', `/api/relay/rest/phone_numbers/${numberSid}`, {
    campaign_id: campaignId,
  });
}

/** Submit a number port-in request. Returns the created port resource. */
async function submitPort(payload) {
  return request('POST', '/api/relay/rest/phone_numbers/port', payload);
}

/** Delete a SIP endpoint (on account cancellation). */
async function deleteSipEndpoint(sipEndpointId) {
  return request('DELETE', `/api/relay/rest/endpoints/sip/${sipEndpointId}`);
}

module.exports = {
  searchAvailableNumbers,
  purchaseNumber,
  createSipEndpoint,
  assignNumberToEndpoint,
  updateSipEndpoint,
  assignNumberToCampaign,
  submitPort,
  deleteSipEndpoint,
  // exposed for tests
  request,
};
