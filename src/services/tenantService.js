/**
 * Tenant service — the MVNE multi-tenant registry.
 *
 * A "tenant" is a reseller/brand running on the platform. This module owns CRUD
 * + lifecycle for the tenants table; it never touches HTTP. Existing per-account
 * queries are NOT yet tenant-scoped (next phase) — this is the foundation.
 *
 * JSONB columns (brand_config, plans, billing_config) are JSON.stringify'd
 * before the query so node-pg doesn't misencode a JS array as a Postgres array;
 * bics_sim_range is a text[] and is passed as a plain JS array.
 */
const db = require('../db');
const { errors } = require('../middleware/errorHandler');

// The seeded MobilityNet tenant (migration 022). Used as the backward-compat
// default before real tenant context exists everywhere.
const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Columns a client may set on create/update. JSONB vs text[] handling differs.
const JSONB_FIELDS = new Set(['brand_config', 'plans', 'billing_config']);
const ARRAY_FIELDS = new Set(['bics_sim_range']);
const UPDATABLE = [
  'name', 'domain', 'acrobits_cloud_id', 'brand_config', 'plans',
  'bics_sim_range', 'telnyx_credential_conn_id', 'roaming_profile_id',
  'billing_config', 'status',
];
const STATUSES = ['onboarding', 'active', 'suspended', 'cancelled'];

/** Coerce a value for its column type (JSONB -> JSON string; array -> array). */
function encode(field, value) {
  if (JSONB_FIELDS.has(field)) return JSON.stringify(value ?? (field === 'plans' ? [] : {}));
  if (ARRAY_FIELDS.has(field)) return Array.isArray(value) ? value : [];
  return value ?? null;
}

function paginate(filters = {}) {
  const rawLimit = Number.parseInt(filters.limit, 10);
  const rawOffset = Number.parseInt(filters.offset, 10);
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit, 1), MAX_LIMIT);
  const offset = Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0);
  return { limit, offset };
}

/**
 * Create a tenant. slug + name are required; slug must be unique (409 on clash).
 * @param {object} input
 */
async function createTenant(input = {}) {
  const slug = typeof input.slug === 'string' ? input.slug.trim().toLowerCase() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!slug) throw errors.validation('slug is required.', 'slug');
  if (!name) throw errors.validation('name is required.', 'name');
  const status = input.status || 'onboarding';
  if (!STATUSES.includes(status)) {
    throw errors.validation(`status must be one of: ${STATUSES.join(', ')}.`, 'status');
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO tenants (
         slug, name, domain, acrobits_cloud_id, brand_config, plans,
         bics_sim_range, telnyx_credential_conn_id, roaming_profile_id,
         billing_config, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        slug,
        name,
        input.domain || null,
        input.acrobits_cloud_id || null,
        encode('brand_config', input.brand_config),
        encode('plans', input.plans),
        encode('bics_sim_range', input.bics_sim_range),
        input.telnyx_credential_conn_id || null,
        input.roaming_profile_id || null,
        encode('billing_config', input.billing_config),
        status,
      ],
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw errors.conflict('A tenant with that slug already exists.', 'slug');
    }
    throw err;
  }
}

async function getTenantById(id) {
  const { rows } = await db.query('SELECT * FROM tenants WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getTenantBySlug(slug) {
  const { rows } = await db.query(
    'SELECT * FROM tenants WHERE slug = $1',
    [String(slug || '').trim().toLowerCase()],
  );
  return rows[0] || null;
}

async function getTenantByDomain(domain) {
  const { rows } = await db.query(
    'SELECT * FROM tenants WHERE domain = $1',
    [String(domain || '').trim().toLowerCase()],
  );
  return rows[0] || null;
}

/** The seeded MobilityNet tenant (backward-compat default). */
async function getDefaultTenant() {
  return getTenantById(DEFAULT_TENANT_ID);
}

/** Paginated tenant list, optionally filtered by status; newest first. */
async function listTenants(filters = {}) {
  const { limit, offset } = paginate(filters);
  const params = [];
  let where = '';
  if (filters.status) {
    params.push(filters.status);
    where = `WHERE status = $${params.length}`;
  }
  const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS total FROM tenants ${where}`, params);
  const pageParams = params.concat([limit, offset]);
  const { rows } = await db.query(
    `SELECT * FROM tenants ${where}
       ORDER BY created_at DESC
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );
  return { tenants: rows, pagination: { limit, offset, total: countRows[0].total } };
}

/**
 * Update a tenant's mutable fields. Unknown keys are ignored; with no valid
 * fields it returns the current row. 404s a missing tenant.
 */
async function updateTenant(id, updates = {}) {
  const sets = [];
  const params = [];
  UPDATABLE.forEach((field) => {
    if (updates[field] === undefined) return;
    if (field === 'status' && !STATUSES.includes(updates[field])) {
      throw errors.validation(`status must be one of: ${STATUSES.join(', ')}.`, 'status');
    }
    params.push(encode(field, updates[field]));
    sets.push(`${field} = $${params.length}`);
  });

  if (sets.length === 0) {
    const current = await getTenantById(id);
    if (!current) throw errors.notFound('Tenant not found.');
    return current;
  }

  params.push(id);
  const { rows } = await db.query(
    `UPDATE tenants SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
    RETURNING *`,
    params,
  );
  if (rows.length === 0) throw errors.notFound('Tenant not found.');
  return rows[0];
}

/** Set a tenant's status; 404s a missing tenant. */
async function setTenantStatus(id, status) {
  const { rows } = await db.query(
    'UPDATE tenants SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [status, id],
  );
  if (rows.length === 0) throw errors.notFound('Tenant not found.');
  return rows[0];
}

const suspendTenant = (id) => setTenantStatus(id, 'suspended');
const activateTenant = (id) => setTenantStatus(id, 'active');

module.exports = {
  DEFAULT_TENANT_ID,
  createTenant,
  getTenantById,
  getTenantBySlug,
  getTenantByDomain,
  getDefaultTenant,
  listTenants,
  updateTenant,
  suspendTenant,
  activateTenant,
};
