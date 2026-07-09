/**
 * Account service — business logic for the `accounts` table.
 *
 * Owns account creation, retrieval, the status state machine, and field
 * updates. Routes call into here; this module never touches HTTP. All
 * customer-facing output is run through serializeAccount() so secrets
 * (sip_password_hash) never leave the service.
 */
const nodeCrypto = require('crypto');
const qrcode = require('qrcode');
const db = require('../db');
const config = require('../config');
const { errors } = require('../middleware/errorHandler');
const didOrchestration = require('./didOrchestrationService');
const billingMigration = require('./billingMigrationService');
const telgoo5Service = require('./telgoo5Service');
const bics = require('../integrations/bics');
const telnyx = require('../integrations/telnyx');
const { DEFAULT_TENANT_ID } = require('./tenantService');
const crypto = require('../utils/crypto');
const e164 = require('../utils/e164');
const { logger } = require('../utils/logger');

// Plan data cap in MB — pushed to BICS as the endpoint's usage threshold.
const PLAN_THRESHOLD_MB = {
  starter_10: 1024,
  unlimited_25: 30720,
  unlimited_25_plus: 30720,
};

// Market used when a number is outside any launched market — customers can pick
// any US area code, so we don't gate on market membership.
const DEFAULT_MARKET = 'direct';

// Customer-facing message when the eSIM step fails but the account is kept.
const BICS_RETRY_MESSAGE = 'BICS provisioning failed — retry from admin';

// Plan slugs the dashboard offers; must stay in sync with lib/plans.ts there.
// unlimited_25 remains the default (see validatePlan / CLAUDE.md).
const PLANS = ['starter_10', 'unlimited_25', 'unlimited_25_plus'];
const STATUSES = ['pending', 'active', 'suspended', 'cancelled'];

// Allowed status transitions. An account can always be cancelled; it cannot
// leave the terminal 'cancelled' state.
const STATUS_TRANSITIONS = {
  pending: ['active', 'cancelled'],
  active: ['suspended', 'cancelled'],
  suspended: ['active', 'cancelled'],
  cancelled: [],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sentinel meaning "set this column to SQL NOW()" in a dynamic update.
const NOW = Symbol('NOW');

/**
 * Strip internal/secret columns before returning an account to a client. Only
 * sip_password_hash is removed; every other column passes through, so the
 * billing/broadband/promo and Telgoo5 fields (external_billing_provider,
 * broadband_provider, broadband_account_id, promo_code, telgoo5_customer_id,
 * telgoo5_enrollment_id), the enrollment details (first_name, last_name,
 * service_address, billing_address), and the E911 fields (e911_address_id,
 * e911_enabled) are all included. For primary accounts
 * (parent_account_id NULL) we expose line_count — the number of child lines —
 * from a `line_count` query column (correlated subquery), defaulting to 0.
 */
function serializeAccount(row) {
  if (!row) return row;
  // Strip secrets: the SIP password hash and the port-out PIN never travel in a
  // general account response — the PIN is served only via the dedicated
  // port-pin endpoints (customer self + admin CSR).
  const {
    // eslint-disable-next-line camelcase, no-unused-vars
    sip_password_hash: _sipHash, port_out_pin: _portPin, line_count: lineCount, ...safe
  } = row;
  if (safe.parent_account_id == null) {
    safe.line_count = lineCount != null ? Number(lineCount) : 0;
  }
  return safe;
}

/** Generate a 6-digit numeric port-out PIN (100000–999999). */
function generatePortPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeEmail(value) {
  if (typeof value !== 'string' || !EMAIL_RE.test(value.trim())) {
    throw errors.validation('A valid email is required.', 'email');
  }
  return value.trim().toLowerCase();
}

function validatePlan(value) {
  if (value === undefined || value === null) return 'unlimited_25';
  if (!PLANS.includes(value)) {
    throw errors.validation(`Unknown plan: ${value}.`, 'plan');
  }
  return value;
}

function assertUuid(id) {
  if (!UUID_RE.test(id || '')) {
    throw errors.validation('Invalid account id.', 'id');
  }
}

/** Optional name field → trimmed string (max 50), or null. */
function validateName(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw errors.validation(`${field} must be a string.`, field);
  }
  return value.trim().slice(0, 50) || null;
}

/**
 * Trimmed, length-capped optional string for flat profile columns
 * (address_line1, city, zip, phone_alt, …). Returns null when empty/absent so
 * clearing a field writes NULL rather than an empty string.
 */
function trimmedField(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw errors.validation(`${field} must be a string.`, field);
  }
  return value.trim().slice(0, maxLength) || null;
}

/**
 * Optional address → normalized { line1, line2, city, state, zip } (each a
 * string or null), or null when absent. Throws if a non-object is supplied.
 */
function validateAddress(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw errors.validation(`${field} must be an object.`, field);
  }
  const str = (v) => (v === undefined || v === null ? null : String(v));
  return {
    line1: str(value.line1),
    line2: str(value.line2),
    city: str(value.city),
    state: str(value.state),
    zip: str(value.zip),
  };
}

// PO Boxes (and similar non-physical addresses) can't be used for mobile
// service — E911 can't dispatch emergency responders to them.
const PO_BOX_RE = /p\.?\s*o\.?\s*box|post\s*office|pmb|general\s*delivery/i;
const PHYSICAL_ADDRESS_MESSAGE = 'A physical street address is required. PO Boxes are not accepted.';

/** True when a line looks like a PO Box / non-physical address. */
function isPoBox(value) {
  return Boolean(value) && PO_BOX_RE.test(value);
}

/** Throw if line1/line2 of an address look like a PO Box. */
function assertNotPoBox(address, field) {
  if (address && (isPoBox(address.line1) || isPoBox(address.line2))) {
    throw errors.validation(PHYSICAL_ADDRESS_MESSAGE, field);
  }
}

/**
 * Service address is mandatory (E911): must be an object with non-empty
 * line1/city/state/zip and must not be a PO Box. Returns the normalized address.
 */
function validateServiceAddress(value) {
  const addr = validateAddress(value, 'service_address');
  const complete = addr
    && ['line1', 'city', 'state', 'zip'].every((k) => addr[k] && String(addr[k]).trim());
  if (!complete) {
    throw errors.validation(PHYSICAL_ADDRESS_MESSAGE, 'service_address');
  }
  assertNotPoBox(addr, 'service_address');
  return addr;
}

function assertTransition(from, to) {
  if (!STATUSES.includes(to)) {
    throw errors.validation(`Unknown status: ${to}.`, 'status');
  }
  const allowed = STATUS_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw errors.validation(`Cannot change status from ${from} to ${to}.`, 'status');
  }
}

/**
 * Pull the new endpoint id out of a BICS CreateEndPoint response envelope. The
 * exact shape isn't contractually pinned, so check the likely locations.
 * Returns null if not present (the caller falls back to the linked SIM record).
 */
function extractEndpointId(createResult) {
  const rp = createResult && createResult.Response && createResult.Response.responseParam;
  if (!rp) return null;
  if (rp.endPointId && rp.endPointId !== '-') return rp.endPointId;
  if (Array.isArray(rp.rows) && rp.rows[0] && rp.rows[0].endPointId) {
    return rp.rows[0].endPointId;
  }
  return null;
}

/**
 * Provision a BICS eSIM for an account: grab an available ICCID, create + link
 * the endpoint, activate it, and read back the eSIM activation code. Throws on
 * any BICS failure (caller decides whether to swallow or surface).
 *
 * @param {{ id: string }} account
 * @returns {Promise<{ iccid, endpointId, activationCode, smDpAddress }>}
 */
async function provisionEsim(account) {
  const iccid = await bics.getNextAvailableEsim();
  const createResult = await bics.createEndpoint({
    name: `mobilitynet-${account.id.slice(0, 8)}`,
    iccid,
    // planId / apnGroupId / roamingProfileId default from config inside bics.
  });

  let endpointId = extractEndpointId(createResult);
  if (!endpointId) {
    // CreateEndPoint didn't surface the id; the now-linked SIM record carries it.
    const linked = await bics.fetchSimByIccid(iccid);
    endpointId = linked && linked.endPointId && linked.endPointId !== '-'
      ? linked.endPointId
      : null;
  }
  if (!endpointId) {
    throw new Error('BICS createEndpoint returned no endPointId');
  }

  await bics.activateEndpoint(endpointId);

  // Best-effort: push the plan's data cap to BICS as the endpoint threshold so
  // the network enforces it. A failure here must never fail signup.
  // NB: BICS create/activate live here (not didOrchestrationService, which is
  // Telnyx-only), so the threshold is set here too.
  const thresholdMb = PLAN_THRESHOLD_MB[account.plan];
  if (thresholdMb) {
    try {
      await bics.updateThreshold(endpointId, {
        threshold: String(thresholdMb),
        counterId: config.bics.dataCounterId,
        // uniqueId is a per-request id for BICS; a UUID keeps each call distinct.
        uniqueId: nodeCrypto.randomUUID(),
      });
      logger.info({ accountId: account.id, endpointId, thresholdMb }, 'BICS data threshold set');
    } catch (err) {
      logger.error(
        { accountId: account.id, endpointId, err: err.message },
        'BICS updateThreshold failed (best-effort)',
      );
    }
  }

  const sim = await bics.fetchSimByIccid(iccid);
  const activation = (sim && sim.activationCode) || {};
  return {
    iccid,
    endpointId,
    activationCode: activation.textQrCode || null,
    // BICS spells the field smDpPlusAdress (sic); expose it as smDpAddress.
    smDpAddress: activation.smDpPlusAdress || null,
  };
}

/**
 * Persist a BICS eSIM result on the account. Writes both bics_iccid and the
 * legacy esim_iccid (kept in sync so the ICCID is never left NULL) plus the
 * activation code (LPA string) so the QR can be re-rendered without BICS.
 * @returns {Promise<object|null>} the updated account row.
 */
async function persistEsim(id, esim) {
  const { rows } = await db.query(
    `UPDATE accounts
        SET bics_endpoint_id = $1,
            bics_iccid = $2,
            esim_iccid = $2,
            esim_activation_code = $3,
            bics_provisioned = true,
            esim_download_count = 1
      WHERE id = $4
    RETURNING *`,
    [esim.endpointId, esim.iccid, esim.activationCode, id],
  );
  return rows[0] || null;
}

/**
 * Attempt eSIM provisioning and persist the result. Best-effort: a BICS failure
 * is logged and swallowed (the account + DID are already created), leaving
 * bics_provisioned=false for a later retry. Returns the (possibly updated)
 * account row plus the esim payload / error for the response.
 */
async function provisionAndPersistEsim(account) {
  try {
    const esim = await provisionEsim(account);
    const updated = await persistEsim(account.id, esim);
    logger.info(
      { accountId: account.id, iccid: esim.iccid, endpointId: esim.endpointId },
      'BICS eSIM provisioned',
    );
    return { account: updated || account, esim };
  } catch (err) {
    // Do NOT roll back: the Telnyx DID is already purchased and the account row
    // exists. Flag for retry instead.
    logger.error(
      { accountId: account.id, err: err.message },
      'BICS eSIM provisioning failed; account kept, retry needed',
    );
    return { account, esim: null, esimError: BICS_RETRY_MESSAGE };
  }
}

/**
 * Create a new account in 'pending' status, provisioning its DID + SIP endpoint
 * in the same call (CLAUDE.md DoD #1: DID assigned at creation).
 *
 * Sequence: validate -> pre-check email -> orchestrate DID/SIP on SignalWire
 * (external, no DB writes) -> persist account + did rows in one transaction.
 * The SignalWire side effects run BEFORE the inserts so a failure leaves no
 * orphan account; the unique constraint on email is the final backstop against
 * a race. The plaintext SIP password from orchestration is hashed (bcrypt) and
 * never stored in the clear — it will be rotated and surfaced at provision time.
 *
 * Multi-line: when `parent_email` is supplied, the new account is a child line
 * under that primary account. Child lines share the primary's email (so the
 * email-uniqueness pre-check is skipped) but still get their own DID, eSIM, and
 * provisioning. parent_email pointing at no primary account is rejected.
 *
 * @param {{ email: string, market: string, plan?: string,
 *           parent_email?: string, line_label?: string, promo_code?: string,
 *           first_name?: string, last_name?: string, service_address?: object,
 *           billing_address?: object }} input
 * @returns {Promise<object>} the created account (serialized)
 */
async function createAccount(input = {}) {
  const email = normalizeEmail(input.email);
  // The tenant that owns this account + its DID. Defaults to MobilityNet so
  // single-tenant signups are unchanged.
  const tenantId = input.tenant_id || DEFAULT_TENANT_ID;
  // Market is optional. Any US area code is allowed; default to "direct" for
  // numbers outside a launched market (didOrchestration searches by area code).
  const market = (typeof input.market === 'string' && input.market.trim())
    ? input.market.trim()
    : DEFAULT_MARKET;
  const plan = validatePlan(input.plan);
  const lineLabel = input.line_label ? String(input.line_label).trim().slice(0, 50) : null;
  const promoCode = input.promo_code ? String(input.promo_code).trim().slice(0, 100) : null;
  // Enrollment details (Telgoo5). All optional / backward compatible.
  const firstName = validateName(input.first_name, 'first_name');
  const lastName = validateName(input.last_name, 'last_name');
  // Service address is required and must be physical (E911 dispatch). Billing
  // address is optional but, when given, also can't be a PO Box.
  const serviceAddress = validateServiceAddress(input.service_address);
  const billingAddress = validateAddress(input.billing_address, 'billing_address');
  assertNotPoBox(billingAddress, 'billing_address');
  // Promo code routes the subscriber's billing provider (telgoo5 vs gaiia +
  // broadband linkage). external_billing_provider holds the billing provider.
  const { billingProvider, broadbandProvider, broadbandAccountId } = billingMigration
    .determineBillingProvider(promoCode);

  // For a "direct"/unlaunched market, derive the search area code from the
  // chosen (new) or ported number so we can still find a DID in that area code.
  const sourceNumber = input.phone_e164 || (input.port && input.port.number_e164) || null;
  const requestedAreaCode = sourceNumber && e164.isE164(sourceNumber)
    ? e164.areaCodeOf(sourceNumber)
    : null;
  // A customer-selected new number must be purchased EXACTLY (never substituted).
  // Port-ins carry their number through the port flow, not a purchase here, so
  // only phone_e164 (new-number signup) drives an exact purchase.
  const requestedNumber = input.phone_e164 && e164.isE164(input.phone_e164)
    ? input.phone_e164
    : null;

  let parentAccountId = null;
  if (input.parent_email) {
    // Child line: resolve the primary account. Skip the email-uniqueness
    // pre-check — child lines share the primary's email by design.
    const parentEmail = normalizeEmail(input.parent_email);
    const parent = await db.query(
      'SELECT id FROM accounts WHERE email = $1 AND parent_account_id IS NULL',
      [parentEmail],
    );
    if (parent.rows.length === 0) {
      throw errors.notFound('No primary account found for that parent_email.');
    }
    parentAccountId = parent.rows[0].id;
  } else {
    // Primary signup: avoid purchasing a DID for an email that already has a
    // primary account (children sharing the email don't count).
    const existing = await db.query(
      'SELECT id FROM accounts WHERE email = $1 AND parent_account_id IS NULL',
      [email],
    );
    if (existing.rows.length > 0) {
      throw errors.conflict('An account with this email already exists.', 'email');
    }
  }

  // External provisioning (Telnyx). Throws DID_UNAVAILABLE / SIGNALWIRE_ERROR.
  // Pass enrollment so DID orchestration can also provision E911 (best-effort).
  const credentials = await didOrchestration.assignDid(market, requestedAreaCode, {
    firstName, lastName, serviceAddress,
  }, requestedNumber);
  const sipPasswordHash = await crypto.hashPassword(credentials.sipPassword);

  try {
    const account = await db.withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO accounts
           (email, market, plan, phone_e164, sip_username, sip_endpoint_id,
            sip_password_hash, parent_account_id, line_label,
            external_billing_provider, broadband_provider, broadband_account_id, promo_code,
            first_name, last_name, service_address, billing_address,
            e911_address_id, e911_enabled, tenant_id, port_out_pin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         RETURNING *`,
        [
          email,
          market,
          plan,
          credentials.phoneE164,
          credentials.sipUsername,
          credentials.sipEndpointId,
          sipPasswordHash,
          parentAccountId,
          lineLabel,
          billingProvider,
          broadbandProvider,
          broadbandAccountId,
          promoCode,
          firstName,
          lastName,
          serviceAddress,
          billingAddress,
          credentials.e911AddressId || null,
          credentials.e911Enabled || false,
          tenantId,
          generatePortPin(),
        ],
      );
      const accountId = inserted.rows[0].id;
      await client.query(
        `INSERT INTO dids (e164, area_code, market, signalwire_sid, account_id, status, tenant_id)
         VALUES ($1, $2, $3, $4, $5, 'assigned', $6)`,
        [
          credentials.phoneE164,
          credentials.areaCode,
          market,
          credentials.signalwireSid,
          accountId,
          tenantId,
        ],
      );
      return inserted.rows[0];
    });

    logger.info(
      {
        accountId: account.id, market, areaCode: credentials.areaCode, parentAccountId,
      },
      parentAccountId ? 'child line created and DID assigned' : 'account created and DID assigned',
    );

    // Best-effort BICS eSIM provisioning. A failure here does NOT roll back the
    // account (the Telnyx DID is already purchased) — bics_provisioned stays
    // false and the eSIM can be retried from the admin API.
    const { account: finalAccount, esim, esimError } = await provisionAndPersistEsim(account);

    // Auto-activate now that voice/SMS provisioning (Telnyx DID) succeeded.
    // BICS eSIM is best-effort and NOT required for voice/SMS, so we activate
    // even when the eSIM step failed. Best-effort: a status-update hiccup
    // shouldn't fail account creation (the account just stays pending and can
    // be activated from the admin API).
    let activated = serializeAccount(finalAccount);
    let activationOk = false;
    try {
      // eslint-disable-next-line no-use-before-define
      activated = await transitionStatus(finalAccount.id, 'active');
      activationOk = true;
    } catch (activationErr) {
      logger.error(
        { accountId: finalAccount.id, err: activationErr.message },
        'auto-activation failed; account left pending',
      );
    }

    // Best-effort Telgoo5 enrollment sync for standalone (telgoo5) accounts once
    // active. Fire-and-forget: it never blocks or fails account creation
    // (syncAccountToTelgoo5 swallows its own errors; Promise.resolve guards a
    // non-promise return).
    if (activationOk && billingProvider === 'telgoo5' && firstName && serviceAddress) {
      Promise.resolve(
        telgoo5Service.syncAccountToTelgoo5(account.id, {
          firstName,
          lastName,
          serviceAddress,
          billingAddress,
        }),
      ).catch((syncErr) => logger.error(
        { accountId: account.id, err: syncErr.message },
        'Telgoo5 sync dispatch failed',
      ));
    }

    const result = activated;
    result.esim = esim;
    if (esimError) result.esim_error = esimError;
    return result;
  } catch (err) {
    if (err.code === '23505') {
      // Lost the email race after orchestration; the purchased DID is now
      // unattached. Surface conflict; orphaned-DID cleanup is an ops concern.
      logger.warn({ email }, 'email race after DID purchase; DID may be orphaned');
      throw errors.conflict('An account with this email already exists.', 'email');
    }
    throw err;
  }
}

/**
 * Persist a new bcrypt hash for the account's SIP password. Used by the
 * provisioning flow when the SIP password is rotated.
 */
async function setSipPasswordHash(id, hash) {
  assertUuid(id);
  await db.query('UPDATE accounts SET sip_password_hash = $1 WHERE id = $2', [hash, id]);
}

// Correlated child-line count, so serializeAccount can expose line_count on
// primary accounts without a second round-trip.
const LINE_COUNT_SELECT = '(SELECT COUNT(*) FROM accounts c WHERE c.parent_account_id = a.id)::int AS line_count';

/** Fetch a full account by id, or throw NOT_FOUND. */
async function getAccountById(id) {
  assertUuid(id);
  const { rows } = await db.query(
    `SELECT a.*, ${LINE_COUNT_SELECT} FROM accounts a WHERE a.id = $1`,
    [id],
  );
  if (rows.length === 0) {
    throw errors.notFound('Account not found.');
  }
  return serializeAccount(rows[0]);
}

/**
 * Backfill/repair an account's sip_password_hash by fetching the live SIP
 * password from Telnyx and re-hashing it. Fixes accounts created before hash
 * storage (NULL sip_password_hash), which fail Acrobits SIP-credential auth.
 * @returns {Promise<{ updated: true }>}
 */
async function refreshSipPasswordHash(id) {
  const account = await getAccountById(id); // throws NOT_FOUND if missing
  if (!account.sip_endpoint_id) {
    throw errors.validation('Account has no SIP endpoint to refresh from.', 'sip_endpoint_id');
  }
  const password = await didOrchestration.getSipPassword(account.sip_endpoint_id);
  const hash = await crypto.hashPassword(password);
  await setSipPasswordHash(id, hash);
  logger.info({ accountId: id }, 'refreshed sip_password_hash from Telnyx');
  return { updated: true };
}

/**
 * Rotate an account's SIP credentials: delete the old Telnyx credential and
 * create a fresh one (new gencred username + new password), persisting the new
 * username, endpoint id, and bcrypt hash. Returns the plaintext password — the
 * ONLY place it is exposed — so an admin can build a provisioning QR. The
 * plaintext is never stored or logged (security rule #1).
 * @param {string} id - account id.
 * @returns {Promise<{ sip_username: string, sip_password: string, updated: true }>}
 */
async function refreshSipCredentials(id) {
  const account = await getAccountById(id); // throws NOT_FOUND if missing
  if (!account.phone_e164) {
    throw errors.validation('Account has no number to bind SIP credentials to.', 'phone_e164');
  }

  // 1. Delete the old Telnyx SIP credential (best-effort — it may already be gone).
  if (account.sip_endpoint_id) {
    try {
      await telnyx.deleteSipEndpoint(account.sip_endpoint_id);
    } catch (err) {
      logger.warn({ accountId: id, err: err.message }, 'old SIP credential delete failed; continuing');
    }
  }

  // 2. Create a NEW credential — Telnyx auto-generates the username + password.
  // The POST response may NOT include the real sip_username (it can echo the
  // `name`), so GET the credential afterward to read the actual gencred.
  const credentialName = `pivottech-${nodeCrypto.randomUUID()}`;
  const created = await telnyx.createSipEndpoint({
    username: credentialName,
    callerId: account.phone_e164,
  });
  logger.info({
    postName: created.name,
    postSipUsername: created.sip_username,
    postKeys: Object.keys(created || {}),
  }, 'Telnyx credential POST response');
  const sipEndpointId = created.id || created.sid;
  const endpoint = await telnyx.getSipEndpoint(sipEndpointId);
  const sipUsername = endpoint.sip_username;
  const sipPassword = endpoint.sip_password;

  // 3. Persist the new username + endpoint id + password hash.
  const hash = await crypto.hashPassword(sipPassword);
  await db.query(
    'UPDATE accounts SET sip_username = $1, sip_endpoint_id = $2, sip_password_hash = $3 WHERE id = $4',
    [sipUsername, sipEndpointId, hash, id],
  );
  logger.info({ accountId: id }, 'rotated SIP credentials on Telnyx');

  // 4. Return the plaintext once (never stored/logged) for QR generation.
  return { sip_username: sipUsername, sip_password: sipPassword, updated: true };
}

/**
 * Look up the PRIMARY account by email (used for MVP token issuance). Child
 * lines share the primary's email, so this scopes to parent_account_id IS NULL.
 * Returns the full account or throws NOT_FOUND.
 */
async function getAccountByEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  const { rows } = await db.query(
    `SELECT a.*, ${LINE_COUNT_SELECT}
       FROM accounts a
      WHERE a.email = $1 AND a.parent_account_id IS NULL`,
    [email],
  );
  if (rows.length === 0) {
    throw errors.notFound('No account found for that email.');
  }
  return serializeAccount(rows[0]);
}

/**
 * Find a primary account by email OR phone number (partner API lookup). Returns
 * the serialized account, or null if none. Non-throwing.
 * @param {string} value - an email (contains "@") or a phone number.
 */
async function findByEmailOrPhone(value) {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim();
  if (v.includes('@')) {
    const { rows } = await db.query(
      'SELECT * FROM accounts WHERE email = $1 AND parent_account_id IS NULL',
      [v.toLowerCase()],
    );
    return rows[0] ? serializeAccount(rows[0]) : null;
  }
  // Phone: normalize to E.164 when possible (toE164 throws on bad input), else
  // match as given.
  let phone = v;
  try {
    phone = e164.toE164(v);
  } catch {
    phone = v;
  }
  const { rows } = await db.query('SELECT * FROM accounts WHERE phone_e164 = $1', [phone]);
  return rows[0] ? serializeAccount(rows[0]) : null;
}

/**
 * Look up an account by SIP username, returning the RAW row (including
 * sip_password_hash) for credential checks — the Acrobits messaging web
 * services authenticate with the SIP username + password. Internal use only;
 * the result must never be returned to a client unserialized.
 * @param {string} username
 * @returns {Promise<object|null>}
 */
async function lookupBySipUsername(username) {
  if (!username) return null;
  const { rows } = await db.query('SELECT * FROM accounts WHERE sip_username = $1', [username]);
  return rows[0] || null;
}

/**
 * Look up an account by subscriber phone number (E.164), returning the RAW row
 * (including sip_password_hash) for credential checks. This is a fallback for the
 * Acrobits messaging web services: some app template variables substitute the
 * subscriber E.164 (%USERNAME%) rather than the gencred (%AUTH_USERNAME%), so we
 * must be able to authenticate by phone number too. Internal use only — the
 * result must never be returned to a client unserialized.
 * @param {string} phone - a phone number (normalized to E.164 when possible).
 * @returns {Promise<object|null>}
 */
async function lookupByPhoneE164(phone) {
  if (!phone) return null;
  let normalized = phone;
  try {
    normalized = e164.toE164(phone);
  } catch {
    normalized = phone;
  }
  const { rows } = await db.query('SELECT * FROM accounts WHERE phone_e164 = $1', [normalized]);
  return rows[0] || null;
}

/**
 * Return all child lines under a primary account (the customer dashboard's
 * "manage lines" view and the billing roll-up consume this).
 * @param {string} accountId - the primary account id.
 * @returns {Promise<object[]>} serialized child accounts (empty if none).
 */
async function getAccountLines(accountId) {
  assertUuid(accountId);
  const { rows } = await db.query(
    'SELECT * FROM accounts WHERE parent_account_id = $1 ORDER BY created_at',
    [accountId],
  );
  return rows.map(serializeAccount);
}

/**
 * Return the subscriber's port-out PIN. Lazily generates + persists one if the
 * account predates the column (defensive — migration 032 backfills existing
 * rows). Never logs the PIN value.
 * @param {string} id - account id.
 * @returns {Promise<{ port_out_pin: string }>}
 */
async function getPortPin(id) {
  assertUuid(id);
  const { rows } = await db.query('SELECT port_out_pin FROM accounts WHERE id = $1', [id]);
  if (rows.length === 0) {
    throw errors.notFound('Account not found.');
  }
  let pin = rows[0].port_out_pin;
  if (!pin) {
    pin = generatePortPin();
    await db.query('UPDATE accounts SET port_out_pin = $1 WHERE id = $2', [pin, id]);
  }
  return { port_out_pin: pin };
}

/**
 * Generate + persist a fresh port-out PIN for an account. Never logs the value.
 * @param {string} id - account id.
 * @returns {Promise<{ port_out_pin: string }>}
 */
async function resetPortPin(id) {
  assertUuid(id);
  const pin = generatePortPin();
  const { rows } = await db.query(
    'UPDATE accounts SET port_out_pin = $1 WHERE id = $2 RETURNING id',
    [pin, id],
  );
  if (rows.length === 0) {
    throw errors.notFound('Account not found.');
  }
  logger.info({ accountId: id }, 'port-out PIN reset');
  return { port_out_pin: pin };
}

/**
 * All distinct sip_endpoint_ids referenced by accounts (any status). Used by the
 * orphaned-credential cleanup to tell which Telnyx credentials are still in use.
 * @returns {Promise<string[]>}
 */
async function getSipEndpointIds() {
  const { rows } = await db.query(
    'SELECT DISTINCT sip_endpoint_id FROM accounts WHERE sip_endpoint_id IS NOT NULL',
  );
  return rows.map((r) => r.sip_endpoint_id);
}

/** Lightweight status projection for the app onboarding poll. */
async function getAccountStatus(id) {
  assertUuid(id);
  const { rows } = await db.query(
    'SELECT id, status, phone_e164, activated_at FROM accounts WHERE id = $1',
    [id],
  );
  if (rows.length === 0) {
    throw errors.notFound('Account not found.');
  }
  return rows[0];
}

function buildUpdate(id, updates) {
  const assignments = [];
  const values = [];
  Object.keys(updates).forEach((col) => {
    if (updates[col] === NOW) {
      assignments.push(`${col} = NOW()`);
    } else {
      values.push(updates[col]);
      assignments.push(`${col} = $${values.length}`);
    }
  });
  values.push(id);
  const sql = `UPDATE accounts SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING *`;
  return { sql, values };
}

/**
 * Update mutable account fields (email and/or status). Status changes are
 * validated against the state machine and stamp activated_at / cancelled_at.
 * @param {string} id
 * @param {{ email?: string, status?: string, sip_username?: string,
 *           sip_endpoint_id?: string }} patch
 */
async function updateAccount(id, patch = {}) {
  const current = await getAccountById(id); // throws NOT_FOUND / VALIDATION_ERROR
  const updates = {};

  if (patch.email !== undefined) {
    updates.email = normalizeEmail(patch.email);
  }

  // Profile fields (admin "update-profile"). Trimmed + length-capped, matching
  // account creation; used downstream for CNAM, Account XML <displayName>, and
  // the voicemail greeting fallback.
  if (patch.first_name !== undefined) {
    updates.first_name = validateName(patch.first_name, 'first_name');
  }
  if (patch.last_name !== undefined) {
    updates.last_name = validateName(patch.last_name, 'last_name');
  }

  // Flat address / alt-contact columns (admin "profile" edit). Trimmed and
  // capped to the migration 031 column widths; state is uppercased. PO Boxes
  // are rejected (E911), matching signup.
  if (patch.address_line1 !== undefined) {
    updates.address_line1 = trimmedField(patch.address_line1, 'address_line1', 255);
    if (isPoBox(updates.address_line1)) {
      throw errors.validation(PHYSICAL_ADDRESS_MESSAGE, 'address_line1');
    }
  }
  if (patch.address_line2 !== undefined) {
    updates.address_line2 = trimmedField(patch.address_line2, 'address_line2', 255);
    if (isPoBox(updates.address_line2)) {
      throw errors.validation(PHYSICAL_ADDRESS_MESSAGE, 'address_line2');
    }
  }
  if (patch.city !== undefined) {
    updates.city = trimmedField(patch.city, 'city', 100);
  }
  if (patch.state !== undefined) {
    const st = trimmedField(patch.state, 'state', 2);
    updates.state = st ? st.toUpperCase() : null;
  }
  if (patch.zip !== undefined) {
    updates.zip = trimmedField(patch.zip, 'zip', 10);
  }
  if (patch.phone_alt !== undefined) {
    updates.phone_alt = trimmedField(patch.phone_alt, 'phone_alt', 20);
  }

  // SIP routing fields (admin "update_sip"). Plain string columns — the
  // plaintext SIP password is never set here (it's bcrypt-hashed elsewhere).
  if (patch.sip_username !== undefined) {
    updates.sip_username = patch.sip_username;
  }
  if (patch.sip_endpoint_id !== undefined) {
    updates.sip_endpoint_id = patch.sip_endpoint_id;
  }

  if (patch.status !== undefined && patch.status !== current.status) {
    assertTransition(current.status, patch.status);
    updates.status = patch.status;
    if (patch.status === 'active' && !current.activated_at) {
      updates.activated_at = NOW;
    }
    if (patch.status === 'cancelled') {
      updates.cancelled_at = NOW;
    }
  }

  if (Object.keys(updates).length === 0) {
    throw errors.validation('No updatable fields provided.');
  }

  try {
    const { sql, values } = buildUpdate(id, updates);
    const { rows } = await db.query(sql, values);
    return serializeAccount(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      throw errors.conflict('An account with this email already exists.', 'email');
    }
    throw err;
  }
}

/**
 * Best-effort release of an account's vendor resources: the Telnyx DID (so we
 * stop being billed), its SIP credential, and the BICS data endpoint. Every
 * step logs-and-continues so a vendor hiccup never blocks the caller (status
 * change or account delete).
 * @param {string} id - account id (for logging).
 * @param {object} account - the account row (needs phone_e164, sip_endpoint_id,
 *   bics_endpoint_id).
 * @param {string} context - short phrase for the log line ("cancellation" etc.).
 */
async function releaseVendorResources(id, account, context) {
  if (account.phone_e164) {
    try {
      await telnyx.deletePhoneNumber(account.phone_e164);
      logger.info({ accountId: id }, `released DID at Telnyx on ${context}`);
    } catch (err) {
      logger.warn({ accountId: id, err: err.message }, 'Telnyx DID release failed (best-effort)');
    }
  }
  if (account.sip_endpoint_id) {
    try {
      await telnyx.deleteSipEndpoint(account.sip_endpoint_id);
    } catch (err) {
      logger.warn({ accountId: id, err: err.message }, 'Telnyx SIP credential delete failed (best-effort)');
    }
  }
  if (account.bics_endpoint_id) {
    try {
      // BICS has no hard-delete; suspending the endpoint deactivates service.
      await bics.suspendEndpoint(account.bics_endpoint_id);
      logger.info({ accountId: id }, `deactivated BICS endpoint on ${context}`);
    } catch (err) {
      logger.warn({ accountId: id, err: err.message }, 'BICS endpoint deactivation failed (best-effort)');
    }
  }
}

/**
 * Force a status transition (used by the admin API). Same state-machine rules as
 * updateAccount, exposed directly for operational status changes.
 *
 * On CANCELLATION we also release the number back to Telnyx (so we stop paying
 * for it) plus the SIP credential and BICS endpoint, and drop the DID row — all
 * best-effort so a vendor failure never undoes the status change. Suspension is
 * intentionally left untouched: the subscriber may reactivate.
 */
async function transitionStatus(id, status) {
  const account = await updateAccount(id, { status });

  if (status === 'cancelled') {
    await releaseVendorResources(id, account, 'cancellation');
    try {
      // Release the DID from our inventory (it's gone from Telnyx now too).
      await db.query('DELETE FROM dids WHERE account_id = $1', [id]);
    } catch (err) {
      logger.warn(
        { accountId: id, err: err.message },
        'DID row removal failed on cancellation (best-effort)',
      );
    }
  }

  return account;
}

// Every table with an account_id FK to accounts(id). All child rows must go
// before the account row or the DELETE hits a foreign-key violation. Order
// among them is irrelevant (none reference each other).
const ACCOUNT_CHILD_TABLES = [
  'messages',
  'message_records',
  'call_records',
  'voicemails',
  'usage_records',
  'push_tokens',
  'billing_migrations',
  'provisioning_tokens',
  'port_requests',
  'dids',
];

/**
 * Hard-delete an account and everything attached to it — for removing test /
 * duplicate accounts. Releases the DID at Telnyx and deactivates the BICS
 * endpoint (both best-effort: external cleanup must not block the DB delete),
 * then removes all child rows + the account row in one transaction.
 * @param {string} id
 * @returns {Promise<{ deleted: true }>}
 */
async function deleteAccount(id) {
  const account = await getAccountById(id); // throws NOT_FOUND on a bad id

  // Best-effort external cleanup — a vendor hiccup can't strand a half-deleted
  // account in our DB.
  await releaseVendorResources(id, account, 'deletion');

  await db.withTransaction(async (client) => {
    // Detach any child (family) lines so their parent FK doesn't block the delete.
    await client.query('UPDATE accounts SET parent_account_id = NULL WHERE parent_account_id = $1', [id]);
    for (let i = 0; i < ACCOUNT_CHILD_TABLES.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(`DELETE FROM ${ACCOUNT_CHILD_TABLES[i]} WHERE account_id = $1`, [id]);
    }
    await client.query('DELETE FROM accounts WHERE id = $1', [id]);
  });

  logger.info({ accountId: id }, 'account hard-deleted');
  return { deleted: true };
}

/**
 * Re-run BICS eSIM provisioning for an account whose initial attempt failed
 * (admin retry action). Unlike createAccount's best-effort path, a failure here
 * is surfaced to the caller so the admin sees it. Rejects if the account is
 * already provisioned.
 * @param {string} id
 * @returns {Promise<object>} the updated account plus its esim payload.
 */
async function retryBicsProvisioning(id) {
  assertUuid(id);
  const { rows } = await db.query('SELECT * FROM accounts WHERE id = $1', [id]);
  if (rows.length === 0) {
    throw errors.notFound('Account not found.');
  }
  const account = rows[0];
  if (account.bics_provisioned) {
    throw errors.validation('BICS eSIM is already provisioned for this account.', 'action');
  }

  // Surface failures (BICS_ERROR) to the admin rather than swallowing them.
  const esim = await provisionEsim(account);
  const updated = await persistEsim(id, esim);
  logger.info(
    { accountId: id, iccid: esim.iccid, endpointId: esim.endpointId },
    'BICS eSIM provisioning retried',
  );
  const result = serializeAccount(updated);
  result.esim = esim;
  return result;
}

/**
 * Build (or rebuild) the eSIM install QR for an account, for the admin UI.
 *   - regenerate=true: provision a fresh BICS endpoint (new eSIM) and use it.
 *   - stored activation code present: render from it, no BICS call.
 *   - a BICS endpoint exists but no stored code: read the code live from BICS.
 *   - otherwise: provision a new BICS endpoint.
 * The QR is a data URL rendered from the LPA activation string.
 * @param {string} id
 * @param {{ regenerate?: boolean }} [opts]
 * @returns {Promise<{ qr_code_url, iccid, endpoint_id, activation_code, sm_dp_address }>}
 */
const ESIM_DOWNLOAD_LIMIT = 3;

async function getEsimQr(id, { regenerate = false } = {}) {
  assertUuid(id);
  const { rows } = await db.query('SELECT * FROM accounts WHERE id = $1', [id]);
  if (rows.length === 0) throw errors.notFound('Account not found.');
  const account = rows[0];

  let iccid;
  let endpointId;
  let activationCode;
  let smDpAddress = null;

  // Re-download tracking: reusing an existing eSIM's QR counts as a download.
  // The Nth (limit) download forces a fresh BICS endpoint instead of reuse.
  let forceRegenerate = regenerate;
  if (!regenerate && account.bics_endpoint_id) {
    const nextCount = (account.esim_download_count || 1) + 1;
    if (nextCount >= ESIM_DOWNLOAD_LIMIT) {
      forceRegenerate = true; // too many downloads — issue a new eSIM
    } else {
      await db.query('UPDATE accounts SET esim_download_count = $1 WHERE id = $2', [nextCount, id]);
      if (nextCount === 2) {
        logger.warn({ accountId: id, count: nextCount }, 'eSIM has been downloaded 2 of 3 allowed times.');
      }
    }
  }

  if (forceRegenerate || !account.bics_endpoint_id) {
    // Regenerate, or first-time provisioning: create a fresh BICS endpoint.
    const esim = await provisionEsim(account);
    await persistEsim(id, esim);
    ({
      iccid, endpointId, activationCode, smDpAddress,
    } = esim);
  } else if (account.esim_activation_code) {
    // Endpoint exists and we already have the code — no BICS round-trip.
    activationCode = account.esim_activation_code;
    iccid = account.bics_iccid || account.esim_iccid || null;
    endpointId = account.bics_endpoint_id;
  } else {
    // Endpoint exists but the code was never stored: read it live from BICS.
    const sim = await bics.fetchSimByIccid(account.bics_iccid);
    const activation = (sim && sim.activationCode) || {};
    activationCode = activation.textQrCode || null;
    smDpAddress = activation.smDpPlusAdress || null;
    iccid = account.bics_iccid;
    endpointId = account.bics_endpoint_id;
    if (activationCode) {
      await db.query(
        'UPDATE accounts SET esim_activation_code = $1 WHERE id = $2',
        [activationCode, id],
      );
    }
  }

  if (!activationCode) {
    throw errors.validation('No eSIM activation code available for this account.', 'esim');
  }

  const qrCodeUrl = await qrcode.toDataURL(activationCode, { errorCorrectionLevel: 'M' });
  logger.info(
    { accountId: id, endpointId, regenerate: forceRegenerate },
    'eSIM QR generated for admin',
  );
  return {
    qr_code_url: qrCodeUrl,
    iccid: iccid || null,
    endpoint_id: endpointId || null,
    activation_code: activationCode,
    sm_dp_address: smDpAddress,
  };
}

module.exports = {
  createAccount,
  getAccountById,
  getAccountByEmail,
  getAccountLines,
  findByEmailOrPhone,
  lookupBySipUsername,
  lookupByPhoneE164,
  getAccountStatus,
  updateAccount,
  transitionStatus,
  deleteAccount,
  getPortPin,
  resetPortPin,
  getSipEndpointIds,
  retryBicsProvisioning,
  getEsimQr,
  setSipPasswordHash,
  refreshSipPasswordHash,
  refreshSipCredentials,
  serializeAccount,
  // exported for tests / reuse
  STATUS_TRANSITIONS,
  STATUSES,
};
