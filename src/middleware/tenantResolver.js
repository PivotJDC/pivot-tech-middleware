/**
 * Tenant resolver middleware (multi-tenant).
 *
 * Resolves the active tenant for a request and attaches it as req.tenant, trying
 * in order:
 *   (a) Host header      -> getTenantByDomain
 *   (b) x-tenant-slug     -> getTenantBySlug
 *   (c) JWT tenant_id claim (populated by an earlier auth middleware, if any)
 * Falls back to the default MobilityNet tenant when nothing matches, so existing
 * single-tenant behavior is preserved (backward compatible).
 *
 * A 60s in-memory cache (keyed by domain and slug) avoids a DB lookup on every
 * request. Never blocks the request: resolution failures are logged and the
 * request proceeds with req.tenant possibly null.
 *
 * Mounted in app.js after body parsing and before the routes.
 */
const tenantService = require('../services/tenantService');
const { logger } = require('../utils/logger');

const CACHE_TTL_MS = 60 * 1000;
// key -> { tenant, expires }. Small (one entry per active domain/slug).
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined; // never looked up
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.tenant; // may be null (negative cache)
}

function cacheSet(key, tenant) {
  cache.set(key, { tenant, expires: Date.now() + CACHE_TTL_MS });
}

/** Cached lookup by domain (best-effort). */
async function byDomain(host) {
  const key = `domain:${host}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  try {
    const tenant = await tenantService.getTenantByDomain(host);
    cacheSet(key, tenant);
    return tenant;
  } catch (err) {
    logger.warn({ err: err.message }, 'tenant resolution by domain failed');
    return null;
  }
}

/** Cached lookup by slug (best-effort). */
async function bySlug(slug) {
  const key = `slug:${String(slug).trim().toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  try {
    const tenant = await tenantService.getTenantBySlug(slug);
    cacheSet(key, tenant);
    return tenant;
  } catch (err) {
    logger.warn({ err: err.message }, 'tenant resolution by slug failed');
    return null;
  }
}

/** Uncached lookups (id / default) — best-effort. */
async function tryResolve(fn, arg) {
  try {
    return await fn(arg);
  } catch (err) {
    logger.warn({ err: err.message }, 'tenant resolution step failed');
    return null;
  }
}

async function tenantResolver(req, res, next) {
  let tenant = null;

  // (a) Host header -> domain (strip port; case-insensitive).
  const host = (req.headers.host || '').split(':')[0].trim().toLowerCase();
  if (host) tenant = await byDomain(host);

  // (b) x-tenant-slug header.
  if (!tenant) {
    const slug = req.headers['x-tenant-slug'];
    if (slug) tenant = await bySlug(String(slug));
  }

  // (c) JWT tenant_id claim, if a prior auth middleware attached it.
  if (!tenant) {
    const claimTenantId = (req.auth && req.auth.claims && req.auth.claims.tenant_id)
      || (req.admin && req.admin.tenant_id);
    if (claimTenantId) tenant = await tryResolve(tenantService.getTenantById, claimTenantId);
  }

  // Default to MobilityNet for backward compatibility.
  if (!tenant) tenant = await tryResolve(tenantService.getDefaultTenant, undefined);

  req.tenant = tenant;
  next();
}

/** Test seam: clear the resolver's cache. */
function resetCache() {
  cache.clear();
}

module.exports = { tenantResolver, resetCache };
