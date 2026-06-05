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
const crypto = require('../utils/crypto');
const { logger } = require('../utils/logger');

const PLANS = ['unlimited_25'];
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

/** Strip internal/secret columns before returning an account to a client. */
function serializeAccount(row) {
  if (!row) return row;
  // eslint-disable-next-line camelcase, no-unused-vars
  const { sip_password_hash, ...safe } = row;
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
 * @param {{ email: string, market: string, plan?: string }} input
 * @returns {Promise<object>} the created account (serialized)
 */
async function createAccount(input = {}) {
  const email = normalizeEmail(input.email);
  const market = validateMarket(input.market);
  const plan = validatePlan(input.plan);

  // Pre-check to avoid purchasing a DID for an email that already exists.
  const existing = await db.query('SELECT id FROM accounts WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw errors.conflict('An account with this email already exists.', 'email');
  }

  // External provisioning (SignalWire). Throws DID_UNAVAILABLE / SIGNALWIRE_ERROR.
  const credentials = await didOrchestration.assignDid(market);
  const sipPasswordHash = await crypto.hashPassword(credentials.sipPassword);

  try {
    const account = await db.withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO accounts
           (email, market, plan, phone_e164, sip_username, sip_endpoint_id, sip_password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          email,
          market,
          plan,
          credentials.phoneE164,
          credentials.sipUsername,
          credentials.sipEndpointId,
          sipPasswordHash,
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
      { accountId: account.id, market, areaCode: credentials.areaCode },
      'account created and DID assigned',
    );
    return serializeAccount(account);
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

/** Fetch a full account by id, or throw NOT_FOUND. */
async function getAccountById(id) {
  assertUuid(id);
  const { rows } = await db.query('SELECT * FROM accounts WHERE id = $1', [id]);
  if (rows.length === 0) {
    throw errors.notFound('Account not found.');
  }
  return serializeAccount(rows[0]);
}

/**
 * Look up an account by email (used for MVP token issuance). Returns the full
 * account or throws NOT_FOUND. Email is matched case-insensitively via the
 * normalized (lowercased) stored value.
 */
async function getAccountByEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  const { rows } = await db.query('SELECT * FROM accounts WHERE email = $1', [email]);
  if (rows.length === 0) {
    throw errors.notFound('No account found for that email.');
  }
  return serializeAccount(rows[0]);
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

module.exports = {
  createAccount,
  getAccountById,
  getAccountByEmail,
  getAccountStatus,
  updateAccount,
  transitionStatus,
  setSipPasswordHash,
  serializeAccount,
  // exported for tests / reuse
  STATUS_TRANSITIONS,
  STATUSES,
};
