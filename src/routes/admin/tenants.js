/**
 * Super-admin tenant management (mounted at /admin/tenants).
 *
 * The parent admin router applies adminAuth + requireRole('super_admin') at the
 * mount point, so every route here is already super-admin-gated. Handlers stay
 * thin; all logic lives in tenantService.
 *
 *   POST   /admin/tenants            create
 *   GET    /admin/tenants            list (filters: status, limit, offset)
 *   GET    /admin/tenants/:id        detail
 *   PATCH  /admin/tenants/:id        update
 *   POST   /admin/tenants/:id/suspend
 *   POST   /admin/tenants/:id/activate
 */
const express = require('express');
const tenantService = require('../../services/tenantService');
const adminService = require('../../services/adminService');
const { asyncHandler, errors } = require('../../middleware/errorHandler');
const { logger } = require('../../utils/logger');

const router = express.Router();

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const tenant = await tenantService.createTenant(req.body || {});
    logger.info(
      { adminId: req.admin.id, tenantId: tenant.id, slug: tenant.slug },
      'tenant created',
    );
    res.status(201).json(tenant);
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await tenantService.listTenants(req.query));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const tenant = await tenantService.getTenantById(req.params.id);
    if (!tenant) throw errors.notFound('Tenant not found.');
    res.json(tenant);
  }),
);

// Accounts belonging to a specific tenant (super_admin cross-tenant view).
router.get(
  '/:id/accounts',
  asyncHandler(async (req, res) => {
    res.json(await adminService.listAccounts({ ...req.query, tenantId: req.params.id }));
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const tenant = await tenantService.updateTenant(req.params.id, req.body || {});
    logger.info({ adminId: req.admin.id, tenantId: req.params.id }, 'tenant updated');
    res.json(tenant);
  }),
);

router.post(
  '/:id/suspend',
  asyncHandler(async (req, res) => {
    const tenant = await tenantService.suspendTenant(req.params.id);
    logger.info({ adminId: req.admin.id, tenantId: req.params.id }, 'tenant suspended');
    res.json(tenant);
  }),
);

router.post(
  '/:id/activate',
  asyncHandler(async (req, res) => {
    const tenant = await tenantService.activateTenant(req.params.id);
    logger.info({ adminId: req.admin.id, tenantId: req.params.id }, 'tenant activated');
    res.json(tenant);
  }),
);

module.exports = router;
