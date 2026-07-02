/**
 * BICS SIMforThings integration — the ONLY module that talks to BICS
 * (CLAUDE.md: never call a vendor directly from routes/services elsewhere).
 * BICS is the cellular data layer: it owns the eSIM inventory and the data
 * endpoints that voice/SMS ride over as SIP/IP.
 *
 * Wraps the BICS SFT REST API with token auth and the mandated retry policy:
 * 3 retries with 1s / 2s / 4s exponential backoff. 4xx responses (client
 * errors, except 429) are not retried. When all retries are exhausted, we log,
 * emit an ops alert hook, and throw BICS_ERROR.
 *
 * Auth model (different from Telnyx's static Bearer key):
 *   - POST /login {username,password} -> { "AccessToken": "..." } (capital A)
 *   - the token rides in the `X-Authorization: Bearer <token>` header, NOT the
 *     standard `Authorization` header
 *   - every request also needs `X-Requested-With: XMLHttpRequest`
 *   - tokens expire; we cache the token in memory and, on a 401, re-auth ONCE
 *     and replay the request transparently
 *
 * Response envelope: most data calls wrap their payload as
 *   { "Response": { "resultCode": "0"|"1", "resultParam": { resultCode,
 *     resultDescription }, "responseParam": { rows: [...] } } }
 * resultCode "0" is success, "1" is a business failure -> BICS_ERROR.
 *
 * Uses the global fetch from Node 20. The backoff base is read from
 * config.bics.retryBaseMs (default 1000) so tests can shrink it.
 */
const config = require('../config');
const { logger } = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

// Backoff multipliers; actual delay = multiplier * retryBaseMs.
const BACKOFF_STEPS = [1, 2, 4];

// In-memory access token cache. Lazily populated by authenticate() and
// refreshed when BICS returns 401. Never logged, never persisted.
let cachedToken = null;

function baseUrl() {
  return config.bics.baseUrl || 'https://sft.bics.com/api';
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function retryDelay(attempt) {
  const baseMs = config.bics.retryBaseMs || 1000;
  return BACKOFF_STEPS[attempt] * baseMs;
}

/** Placeholder ops-alert hook (CLAUDE.md: "queue for ops alert"). */
function emitOpsAlert(detail) {
  // TODO: publish to SQS_NOTIFICATION_QUEUE_URL when the queue layer lands.
  logger.error({ ...detail, opsAlert: true }, 'BICS ops alert');
}

/**
 * Issue an HTTP request with the transport/5xx/429 retry policy. Returns the
 * raw fetch Response so the caller can inspect status (notably 401 for the
 * re-auth flow). Throws BICS_ERROR only once transport/5xx retries are
 * exhausted; non-retryable statuses (2xx, 4xx including 401) are returned.
 */
async function sendWithRetry(method, url, init) {
  let lastDetail;
  // attempt 0 is the first try; attempts 1..3 are the retries.
  for (let attempt = 0; attempt <= BACKOFF_STEPS.length; attempt += 1) {
    let res;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(url, init);
    } catch (networkErr) {
      // Network/transport failure — retryable.
      lastDetail = { method, url, reason: networkErr.message };
      if (attempt < BACKOFF_STEPS.length) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelay(attempt));
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    // 5xx or 429 — retryable.
    if (res.status >= 500 || res.status === 429) {
      lastDetail = { method, url, status: res.status };
      if (attempt < BACKOFF_STEPS.length) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelay(attempt));
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    // 2xx, or a non-retryable 4xx (including 401, handled by the caller).
    return res;
  }

  emitOpsAlert(lastDetail);
  throw new AppError('BICS_ERROR', 'BICS request failed after retries.', { status: 502 });
}

/**
 * Authenticate against BICS and cache the AccessToken in memory.
 * Re-callable to force a refresh; returns the token string.
 *
 * When config.bics.targetAccountId is set we authenticate with "support access"
 * (reseller) semantics — the targetAccountId scopes the session to a child
 * enterprise account. Omitted entirely when not configured.
 */
async function authenticate() {
  const url = `${baseUrl()}/login`;
  const supportAccess = Boolean(config.bics.targetAccountId);
  logger.info({ supportAccess }, supportAccess
    ? 'BICS authenticating with support access (reseller → child account)'
    : 'BICS authenticating');
  const res = await sendWithRetry('POST', url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      username: config.bics.username,
      password: config.bics.password,
      ...(config.bics.targetAccountId && {
        targetAccountId: config.bics.targetAccountId,
      }),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ status: res.status, body: text }, 'BICS authentication failed');
    throw new AppError('BICS_ERROR', `BICS authentication failed (${res.status}).`, { status: 502 });
  }

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  // Note the capital A — the BICS field is `AccessToken`.
  if (!body.AccessToken) {
    throw new AppError('BICS_ERROR', 'BICS login returned no AccessToken.', { status: 502 });
  }

  cachedToken = body.AccessToken;
  return cachedToken;
}

/**
 * Issue an authenticated BICS request. Resolves the parsed JSON body (or null
 * for empty/204). Transparently re-authenticates and replays once on a 401
 * (expired token). Throws BICS_ERROR on client errors, transport exhaustion,
 * or a business-failure envelope (Response.resultCode !== "0").
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipEnvelopeCheck] - when true, do NOT throw on a
 *   non-"0" top-level resultCode. Used by the action endpoints whose
 *   success/failure is decided by the inner resultParam.resultCode (and which
 *   treat some "failure" codes, e.g. "already active", as idempotent success).
 */
async function request(method, path, body, opts = {}) {
  if (!cachedToken) await authenticate();

  const url = `${baseUrl()}${path}`;
  const buildInit = () => ({
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Authorization': `Bearer ${cachedToken}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let res = await sendWithRetry(method, url, buildInit());

  // Token expired — re-auth once and replay with the fresh token.
  if (res.status === 401) {
    await authenticate();
    res = await sendWithRetry(method, url, buildInit());
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({
      method, path, status: res.status, body: text,
    }, 'BICS client error');
    throw new AppError('BICS_ERROR', `BICS rejected ${method} ${path} (${res.status}).`, { status: 502 });
  }

  const text = res.status === 204 ? '' : await res.text();
  const payload = text ? JSON.parse(text) : null;

  // Business-failure envelope: resultCode "0" = success, "1" = failure.
  const envelope = payload && payload.Response;
  if (!opts.skipEnvelopeCheck
    && envelope && envelope.resultCode !== undefined && envelope.resultCode !== '0') {
    const rp = envelope.resultParam || {};
    logger.error({
      method, path, resultCode: rp.resultCode, resultDescription: rp.resultDescription,
    }, 'BICS returned failure result');
    throw new AppError(
      'BICS_ERROR',
      `BICS ${method} ${path} failed: ${rp.resultDescription || 'unknown error'}.`,
      { status: 502 },
    );
  }

  return payload;
}

/** Pull the `Response.responseParam.rows` array out of an envelope, safely. */
function envelopeRows(payload) {
  const rows = payload
    && payload.Response
    && payload.Response.responseParam
    && payload.Response.responseParam.rows;
  return Array.isArray(rows) ? rows : [];
}

/** Pull `Response.responseParam` out of an envelope, safely ({} if absent). */
function envelopeResponseParam(payload) {
  return (payload && payload.Response && payload.Response.responseParam) || {};
}

/** Pull `Response.resultParam` out of an envelope, safely ({} if absent). */
function envelopeResultParam(payload) {
  return (payload && payload.Response && payload.Response.resultParam) || {};
}

/**
 * Validate a BICS action response by its inner resultParam.resultCode against
 * the documented success codes. Logs + throws BICS_ERROR otherwise. Returns the
 * resultParam so callers can read its code/description.
 */
function assertResultCode(action, endPointId, payload, okCodes) {
  const rp = envelopeResultParam(payload);
  if (okCodes.includes(rp.resultCode)) return rp;
  logger.error({
    action, endPointId, resultCode: rp.resultCode, resultDescription: rp.resultDescription,
  }, 'BICS action failed');
  throw new AppError(
    'BICS_ERROR',
    `BICS ${action} failed for endpoint ${endPointId}: ${rp.resultDescription || rp.resultCode || 'unknown error'}.`,
    { status: 502 },
  );
}

// --- Typed API surface ---

/**
 * Fetch the full SIM inventory. Returns the parsed rows array
 * (Response.responseParam.rows), or [] when empty.
 */
async function fetchSimInventory() {
  const payload = await request('GET', '/fetchSIM');
  return envelopeRows(payload);
}

/**
 * List the roaming profiles available to our account, so a valid
 * roamingProfileId can be chosen for CreateEndPoint.
 *
 * NB: BICS SFT has no dedicated "GetRoamingProfiles" endpoint — per the SFT API
 * FAQ, the roaming profile ids (together with plan ids) are returned by
 * GET /GetPlans. We return the raw rows so the caller can read each entry's id
 * and name and identify the correct profile. Returns [] when empty.
 */
async function listRoamingProfiles() {
  const payload = await request('GET', '/GetPlans');
  return envelopeRows(payload);
}

/**
 * Fetch a single SIM by ICCID. Returns the SIM detail object — which carries
 * the eSIM activation code used to render the install QR:
 *   activationCode.textQrCode      (the LPA string)
 *   activationCode.smDpPlusAdress  (SM-DP+ server) [BICS spelling, sic]
 *   activationCode.matchingId
 * plus eid, simStatus, endPointId, etc. Returns null if not found.
 */
async function fetchSimByIccid(iccid) {
  const params = new URLSearchParams({ iccid });
  const payload = await request('GET', `/fetchSIM?${params.toString()}`);
  const rows = envelopeRows(payload);
  return rows.length ? rows[0] : null;
}

/**
 * Find the next eSIM that is available to provision. Filters the inventory for
 * an unassigned, ready-to-activate consumer eUICC SIM and returns its ICCID.
 * Throws BICS_ERROR if the pool is exhausted (ops must replenish inventory).
 */
async function getNextAvailableEsim() {
  const rows = await fetchSimInventory();
  const available = rows.find((sim) => sim.simProduct === 'IPP Consumer eUICC LPWAN'
    && sim.simStatus === 'Ready To Activate'
    && sim.endPointId === '-');

  if (!available) {
    emitOpsAlert({ reason: 'eSIM pool exhausted' });
    throw new AppError('BICS_ERROR', 'No available eSIMs in the BICS pool.', { status: 502 });
  }
  return available.iccid;
}

/**
 * Create a data endpoint and link it to an eSIM. Defaults for plan / APN group
 * / roaming profile fall back to config (the BICS-supplied ids), so callers
 * normally pass only { name, iccid }.
 */
async function createEndpoint({
  name, iccid, planId, apnGroupId, roamingProfileId, monthlyLimit,
}) {
  return request('POST', '/CreateEndPoint', {
    Request: {
      requestParam: {
        name,
        apnGroupId: apnGroupId || config.bics.apnGroupId,
        roamingProfileId: roamingProfileId || config.bics.roamingProfileId,
        isLinkSIM: 'true',
        iccid,
        isDefaultActivation: 'false',
        planId: planId || config.bics.planId,
        monthlyLimit: monthlyLimit || '1000',
      },
    },
  });
}

/**
 * Activate a data endpoint. Idempotent by design: BICS resultCode
 *   5014 = activated, 2507 = already active
 * both resolve. 6420 (SIM not attached) and any other code throw BICS_ERROR.
 * Returns the responseParam.
 */
async function activateEndpoint(endPointId) {
  const payload = await request(
    'POST',
    '/EndPointActivation',
    { Request: { endPointId } },
    { skipEnvelopeCheck: true },
  );
  // 5014 = newly activated, 2507 = already active (treat as success).
  assertResultCode('activateEndpoint', endPointId, payload, ['5014', '2507']);
  return envelopeResponseParam(payload);
}

/**
 * Change an endpoint's lifecycle state.
 * @param {string} endPointId
 * @param {'A'|'S'|'AI'} lifeCycle - Active, Suspend, Active-Inventory.
 * @param {'1'|'2'|'3'} [reason='1'] - 1 System, 2 Dunning/non-payment, 3 CSR.
 * Success resultCode 5017 or 9003. Returns the responseParam, which includes
 * currentStatus and previousStatus.
 */
async function changeEndpointStatus(endPointId, lifeCycle, reason = '1') {
  const payload = await request(
    'POST',
    '/EndPointLifeCycleChange',
    { Request: { endPointId, requestParam: { lifeCycle, reason } } },
    { skipEnvelopeCheck: true },
  );
  assertResultCode('changeEndpointStatus', endPointId, payload, ['5017', '9003']);
  return envelopeResponseParam(payload);
}

/** Suspend an endpoint (lifeCycle "S"). reason defaults to "1" (System). */
async function suspendEndpoint(endPointId, reason = '1') {
  return changeEndpointStatus(endPointId, 'S', reason);
}

/** Resume an endpoint (lifeCycle "A"). reason defaults to "1" (System). */
async function resumeEndpoint(endPointId, reason = '1') {
  return changeEndpointStatus(endPointId, 'A', reason);
}

/**
 * Fetch usage statistics for an endpoint over a date range.
 * @param {string} endPointId
 * @param {string} fromDate - YYYYMMDD
 * @param {string} toDate - YYYYMMDD
 * Returns Response.responseParam directly:
 *   dataUsage      - list of daily records
 *   dataTotalUsage - { uplink, downlink, totalVolume, totalCost } (MB, 3 dp)
 *   smsUsage, smsTotalUsage
 */
async function getEndpointStatistics(endPointId, fromDate, toDate) {
  const params = new URLSearchParams({
    endPointId,
    from_date: fromDate,
    to_date: toDate,
  });
  const payload = await request('GET', `/GetStatistics?${params.toString()}`);
  return envelopeResponseParam(payload);
}

/**
 * Update an endpoint's usage threshold (in MB). planId falls back to config.
 * @param {string} endPointId
 * @param {{ threshold: string, counterId: string, planId?: string, uniqueId: string }} params
 * Success resultCode 3005. Returns the responseParam.
 */
async function updateThreshold(endPointId, {
  threshold, counterId, planId, uniqueId,
} = {}) {
  const payload = await request(
    'POST',
    '/UpdateThreshold',
    {
      Request: {
        endPointId,
        requestParam: {
          planId: planId || config.bics.planId,
          counterId,
          uniqueId,
          threshold,
        },
      },
    },
    { skipEnvelopeCheck: true },
  );
  assertResultCode('updateThreshold', endPointId, payload, ['3005']);
  return envelopeResponseParam(payload);
}

module.exports = {
  authenticate,
  fetchSimInventory,
  listRoamingProfiles,
  fetchSimByIccid,
  getNextAvailableEsim,
  createEndpoint,
  activateEndpoint,
  changeEndpointStatus,
  suspendEndpoint,
  resumeEndpoint,
  getEndpointStatistics,
  updateThreshold,
  // exposed for tests
  request,
};
