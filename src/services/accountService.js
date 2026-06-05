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
 * Create a new account in 'pending' status.
 * @param {{ email: string, market: string, plan?: string }} input
 * @returns {Promise<object>} the created account (serialized)
 */
async function createAccount(input = {}) {
  const email = normalizeEmail(input.email);
  const market = validateMarket(input.market);
  const plan = validatePlan(input.plan);

  try {
    const { rows } = await db.query(
      `INSERT INTO accounts (email, market, plan)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [email, market, plan],
    );
    return serializeAccount(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation on accounts.email
      throw errors.conflict('An account with this email already exists.', 'email');
    }
    throw err;
  }
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
  getAccountStatus,
  updateAccount,
  transitionStatus,
  serializeAccount,
  // exported for tests / reuse
  STATUS_TRANSITIONS,
  STATUSES,
};
