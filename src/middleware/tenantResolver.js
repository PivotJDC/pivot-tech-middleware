/**
 * Tenant resolver middleware (MVNE foundation).
 *
 * Resolves the active tenant for a request and attaches it as req.tenant, trying
 * in order:
 *   (a) Host header      -> getTenantByDomain
 *   (b) x-tenant-slug     -> getTenantBySlug
 *   (c) JWT tenant_id claim (populated by an earlier auth middleware, if any)
 * Falls back to the default MobilityNet tenant when nothing matches, so existing
 * single-tenant behavior is preserved (backward compatible).
 *
 * Never blocks the request: tenant resolution failures are logged and the
 * request proceeds (req.tenant may be null). Nothing filters by tenant yet — this
 * only populates req.tenant for the next phase.
 *
 * NOTE: not yet mounted globally in app.js — wiring it (with caching, to avoid a
 * per-request lookup) is part of the next phase.
 */
const tenantService = require('../services/tenantService');
const { logger } = require('../utils/logger');

/** Best-effort: never throw out of a resolution step. */
async function tryResolve(fn, arg) {
  try {
    return arg ? await fn(arg) : null;
  } catch (err) {
    logger.warn({ err: err.message }, 'tenant resolution step failed');
    return null;
  }
}

async function tenantResolver(req, res, next) {
  let tenant = null;

  // (a) Host header -> domain (strip port; case-insensitive).
  const host = (req.headers.host || '').split(':')[0].trim().toLowerCase();
  if (host) tenant = await tryResolve(tenantService.getTenantByDomain, host);

  // (b) x-tenant-slug header.
  if (!tenant) {
    const slug = req.headers['x-tenant-slug'];
    if (slug) tenant = await tryResolve(tenantService.getTenantBySlug, String(slug));
  }

  // (c) JWT tenant_id claim, if a prior auth middleware attached it.
  if (!tenant) {
    const claimTenantId = (req.auth && req.auth.claims && req.auth.claims.tenant_id)
      || (req.admin && req.admin.tenant_id);
    if (claimTenantId) tenant = await tryResolve(tenantService.getTenantById, claimTenantId);
  }

  // Default to MobilityNet for backward compatibility.
  if (!tenant) tenant = await tryResolve(tenantService.getDefaultTenant, true);

  req.tenant = tenant;
  next();
}

module.exports = { tenantResolver };
