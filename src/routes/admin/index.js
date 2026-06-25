/**
 * Admin API (mounted at /admin). Every route requires a valid admin JWT via
 * adminAuth (applied router-wide). Handlers stay thin — data access lives in
 * adminService, account mutations reuse accountService, and token reissue reuses
 * provisioningService.
 *
 *   GET   /admin/accounts                       list (filters: status, market, from, to)
 *   GET   /admin/accounts/:id                   full detail
 *   PATCH /admin/accounts/:id/status            force status (reason, audit-logged)
 *   PATCH /admin/accounts/:id                    action: "retry_bics" — re-run eSIM provisioning
 *   POST  /admin/accounts/:id/provision/reissue new provisioning token + QR
 *   GET   /admin/dids                           inventory (filters: market, status, area_code)
 *   GET   /admin/ports                          port requests (filters: status, carrier)
 *   POST  /admin/ports/:id/retry                resubmit a failed port
 *   GET   /admin/metrics                        operational metrics
 */
const express = require('express');
const adminService = require('../../services/adminService');
const accountService = require('../../services/accountService');
const provisioningService = require('../../services/provisioningService');
const { adminAuth } = require('../../middleware/adminAuth');
const { asyncHandler, errors } = require('../../middleware/errorHandler');
const { logger } = require('../../utils/logger');

const router = express.Router();

// Every admin route is authenticated.
router.use(adminAuth);

// --- Accounts ---

router.get(
  '/accounts',
  asyncHandler(async (req, res) => {
    res.json(await adminService.listAccounts(req.query));
  }),
);

router.get(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    res.json(await accountService.getAccountById(req.params.id));
  }),
);

router.patch(
  '/accounts/:id/status',
  asyncHandler(async (req, res) => {
    const { status, reason } = req.body || {};
    if (!status) {
      throw errors.validation('status is required.', 'status');
    }
    const account = await accountService.transitionStatus(req.params.id, status);
    // Audit: who changed what, and why (CLAUDE.md: logged with admin identity).
    logger.info(
      {
        adminId: req.admin.id, accountId: req.params.id, newStatus: status, reason: reason || null,
      },
      'admin forced account status change',
    );
    res.json(account);
  }),
);

// Status transitions a given admin action maps to. transitionStatus enforces
// the state machine (legal transitions) and stamps activated_at / cancelled_at.
const STATUS_FOR_ACTION = {
  activate: 'active', // pending -> active (extra pending-only guard below)
  suspend: 'suspended', // active -> suspended
  cancel: 'cancelled', // any (non-terminal) -> cancelled
};

router.patch(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    const { action } = req.body || {};
    const { id } = req.params;

    if (action === 'retry_bics') {
      const account = await accountService.retryBicsProvisioning(id);
      logger.info(
        { adminId: req.admin.id, accountId: id },
        'admin retried BICS eSIM provisioning',
      );
      res.json(account);
      return;
    }

    if (action === 'update_sip') {
      const { sip_username: sipUsername, sip_endpoint_id: sipEndpointId } = req.body || {};
      if (sipUsername === undefined && sipEndpointId === undefined) {
        throw errors.validation('sip_username or sip_endpoint_id is required.', 'sip_username');
      }
      const account = await accountService.updateAccount(id, {
        sip_username: sipUsername,
        sip_endpoint_id: sipEndpointId,
      });
      logger.info(
        { adminId: req.admin.id, accountId: id },
        'admin updated SIP credentials',
      );
      res.json(account);
      return;
    }

    const targetStatus = STATUS_FOR_ACTION[action];
    if (!targetStatus) {
      throw errors.validation(
        'Unsupported action. Expected one of: retry_bics, update_sip, activate, suspend, cancel.',
        'action',
      );
    }

    // "activate" is restricted to pending accounts — reactivating a suspended
    // line is intentionally not this action (it would need a separate flow).
    if (action === 'activate') {
      const current = await accountService.getAccountById(id); // throws NOT_FOUND
      if (current.status !== 'pending') {
        throw errors.validation('activate is only allowed from pending status.', 'action');
      }
    }

    const account = await accountService.transitionStatus(id, targetStatus);
    logger.info(
      {
        adminId: req.admin.id, accountId: id, action, newStatus: targetStatus,
      },
      'admin account status transition',
    );
    res.json(account);
  }),
);

router.post(
  '/accounts/:id/provision/reissue',
  asyncHandler(async (req, res) => {
    const result = await provisioningService.reissueToken(req.params.id);
    logger.info(
      { adminId: req.admin.id, accountId: req.params.id },
      'admin reissued provisioning token',
    );
    res.status(201).json(result);
  }),
);

// --- DIDs ---

router.get(
  '/dids',
  asyncHandler(async (req, res) => {
    res.json(await adminService.listDids(req.query));
  }),
);

// --- Ports ---

router.get(
  '/ports',
  asyncHandler(async (req, res) => {
    res.json(await adminService.listPorts(req.query));
  }),
);

router.post(
  '/ports/:id/retry',
  asyncHandler(async (req, res) => {
    const result = await adminService.retryPort(req.params.id);
    logger.info({ adminId: req.admin.id, portId: req.params.id }, 'admin retried port');
    res.json(result);
  }),
);

// --- Metrics ---

router.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    res.json(await adminService.getMetrics());
  }),
);

module.exports = router;
