/**
 * Account service — business logic for the `accounts` table.
 *
 * Owns account creation, retrieval, the status state machine, and field
 * updates. Routes call into here; this module never touches HTTP. All
 * customer-facing output is run through serializeAccount() so secrets
 * (sip_password_hash) never leave the service.
 */
const db = require('../db');
const { errors } = require('../middleware/errorHandler');
const didOrchestration = require('./didOrchestrationService');
const bics = require('../integrations/bics');
const crypto = require('../utils/crypto');
const { logger } = require('../utils/logger');

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
 * Strip internal/secret columns before returning an account to a client.
 * parent_account_id and line_label pass through as plain columns. For primary
 * accounts (parent_account_id NULL) we expose line_count — the number of child
 * lines — taken from a `line_count` column when the query provides it (a
 * correlated subquery), defaulting to 0.
 */
function serializeAccount(row) {
  if (!row) return row;
  // eslint-disable-next-line camelcase, no-unused-vars
  const { sip_password_hash: _sipHash, line_count: lineCount, ...safe } = row;
  if (safe.parent_account_id == null) {
    safe.line_count = lineCount != null ? Number(lineCount) : 0;
  }
  return safe;
}

function normalizeEmail(value) {
  if (typeof value !== 'string' || !EMAIL_RE.test(value.trim())) {
    throw errors.validation('A valid email is required.', 'email');
  }
  return value.trim().toLowerCase();
}

function validateMarket(value) {
  // Markets are config-driven (CLAUDE.md), so we validate shape, not membership.
  if (typeof value !== 'string' || value.trim() === '') {
    throw errors.validation('market is required.', 'market');
  }
  return value.trim();
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
 * Attempt eSIM provisioning and persist the result. Best-effort: a BICS failure
 * is logged and swallowed (the account + DID are already created), leaving
 * bics_provisioned=false for a later retry. Returns the (possibly updated)
 * account row plus the esim payload / error for the response.
 */
async function provisionAndPersistEsim(account) {
  try {
    const esim = await provisionEsim(account);
    const { rows } = await db.query(
      `UPDATE accounts
          SET bics_endpoint_id = $1, bics_iccid = $2, bics_provisioned = true
        WHERE id = $3
      RETURNING *`,
      [esim.endpointId, esim.iccid, account.id],
    );
    logger.info(
      { accountId: account.id, iccid: esim.iccid, endpointId: esim.endpointId },
      'BICS eSIM provisioned',
    );
    return { account: rows[0] || account, esim };
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
 *           parent_email?: string, line_label?: string }} input
 * @returns {Promise<object>} the created account (serialized)
 */
async function createAccount(input = {}) {
  const email = normalizeEmail(input.email);
  const market = validateMarket(input.market);
  const plan = validatePlan(input.plan);
  const lineLabel = input.line_label ? String(input.line_label).trim().slice(0, 50) : null;

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

  // External provisioning (SignalWire). Throws DID_UNAVAILABLE / SIGNALWIRE_ERROR.
  const credentials = await didOrchestration.assignDid(market);
  const sipPasswordHash = await crypto.hashPassword(credentials.sipPassword);

  try {
    const account = await db.withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO accounts
           (email, market, plan, phone_e164, sip_username, sip_endpoint_id,
            sip_password_hash, parent_account_id, line_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        ],
      );
      const accountId = inserted.rows[0].id;
      await client.query(
        `INSERT INTO dids (e164, area_code, market, signalwire_sid, account_id, status)
         VALUES ($1, $2, $3, $4, $5, 'assigned')`,
        [
          credentials.phoneE164,
          credentials.areaCode,
          market,
          credentials.signalwireSid,
          accountId,
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

    const result = serializeAccount(finalAccount);
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
 * @param {{ email?: string, status?: string }} patch
 */
async function updateAccount(id, patch = {}) {
  const current = await getAccountById(id); // throws NOT_FOUND / VALIDATION_ERROR
  const updates = {};

  if (patch.email !== undefined) {
    updates.email = normalizeEmail(patch.email);
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
 * Force a status transition (used by the admin API later). Same state-machine
 * rules as updateAccount, exposed directly for operational status changes.
 */
async function transitionStatus(id, status) {
  return updateAccount(id, { status });
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
  const { rows: updated } = await db.query(
    `UPDATE accounts
        SET bics_endpoint_id = $1, bics_iccid = $2, bics_provisioned = true
      WHERE id = $3
    RETURNING *`,
    [esim.endpointId, esim.iccid, id],
  );
  logger.info(
    { accountId: id, iccid: esim.iccid, endpointId: esim.endpointId },
    'BICS eSIM provisioning retried',
  );
  const result = serializeAccount(updated[0]);
  result.esim = esim;
  return result;
}

module.exports = {
  createAccount,
  getAccountById,
  getAccountByEmail,
  getAccountLines,
  getAccountStatus,
  updateAccount,
  transitionStatus,
  retryBicsProvisioning,
  setSipPasswordHash,
  serializeAccount,
  // exported for tests / reuse
  STATUS_TRANSITIONS,
  STATUSES,
};
