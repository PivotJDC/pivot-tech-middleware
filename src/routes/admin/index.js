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
 *
 *   POST  /admin/login                          public: username+password -> JWT
 *   POST  /admin/users                          super_admin: create admin user
 *   GET   /admin/users                          super_admin: list admin users
 */
const express = require('express');
const adminService = require('../../services/adminService');
const accountService = require('../../services/accountService');
const provisioningService = require('../../services/provisioningService');
const adminUserService = require('../../services/adminUserService');
const cdrService = require('../../services/cdrService');
const usageService = require('../../services/usageService');
const voicemailService = require('../../services/voicemailService');
const s3 = require('../../integrations/s3');
const tenantsRouter = require('./tenants');
const { adminAuth, requireRole } = require('../../middleware/adminAuth');
const { rateLimit } = require('../../middleware/rateLimiter');
const { asyncHandler, errors } = require('../../middleware/errorHandler');
const { logger } = require('../../utils/logger');

const router = express.Router();

/**
 * The tenant a read query should be scoped to:
 *   - super_admin: all tenants (null) unless they explicitly pass ?tenant_id=
 *   - admin/viewer: their own tenant (from the JWT claim / resolved tenant),
 *     and a ?tenant_id override is ignored.
 */
function tenantScope(req) {
  if (req.admin && req.admin.role === 'super_admin') {
    return req.query.tenant_id || null;
  }
  return (req.admin && req.admin.tenant_id) || (req.tenant && req.tenant.id) || null;
}

// --- Login (PUBLIC — must come BEFORE the router-wide adminAuth) ---
// Rate limited to 5 attempts/min/IP to blunt brute force.
router.post(
  '/login',
  rateLimit({ windowMs: 60_000, max: 5 }),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      throw errors.validation('username and password are required.');
    }
    // An admin belongs to a tenant; scope the lookup to the resolved tenant.
    const tenantId = req.tenant && req.tenant.id;
    const result = await adminUserService.login(username, password, tenantId);
    if (!result) {
      throw errors.unauthorized('Invalid username or password.');
    }
    res.json(result);
  }),
);

// Forgot password (PUBLIC). Mints a 15-min reset token (in Redis) and logs the
// link; always answers { sent: true } so it never reveals whether the email
// belongs to an admin. Rate limited like /login.
router.post(
  '/forgot-password',
  rateLimit({ windowMs: 60_000, max: 5 }),
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!email) {
      throw errors.validation('email is required.', 'email');
    }
    await adminUserService.requestPasswordReset(email);
    res.json({ sent: true });
  }),
);

// Reset password (PUBLIC). Exchanges a valid reset token for a new password.
router.post(
  '/reset-password',
  rateLimit({ windowMs: 60_000, max: 5 }),
  asyncHandler(async (req, res) => {
    const { token: resetToken, new_password: newPassword } = req.body || {};
    if (!resetToken || !newPassword) {
      throw errors.validation('token and new_password are required.');
    }
    const ok = await adminUserService.resetPassword(resetToken, newPassword);
    if (!ok) {
      throw errors.unauthorized('Invalid or expired reset token.');
    }
    res.json({ reset: true });
  }),
);

// NB: the one-time POST /admin/bootstrap route is mounted in app.js BEFORE this
// router, so it bypasses the router-wide adminAuth.

// Every admin route below is authenticated.
router.use(adminAuth);

// Tenant management (MVNE). super_admin only, applied at the mount point.
router.use('/tenants', requireRole('super_admin'), tenantsRouter);

// Identity of the currently authenticated admin (username/email/role). Useful
// as a "forgot username" aid for an admin still logged in elsewhere.
router.get(
  '/whoami',
  asyncHandler(async (req, res) => {
    const user = await adminUserService.getByUsername(req.admin.id);
    if (!user) {
      throw errors.notFound('Admin user not found.');
    }
    res.json({ username: user.username, email: user.email, role: user.role });
  }),
);

// --- Admin users (super_admin only) ---

router.post(
  '/users',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const user = await adminUserService.createAdminUser(req.body || {});
    logger.info(
      { adminId: req.admin.id, createdUsername: user.username, role: user.role },
      'admin created an admin user',
    );
    res.status(201).json(user);
  }),
);

router.get(
  '/users',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    res.json({ users: await adminUserService.listAdminUsers(tenantScope(req)) });
  }),
);

router.patch(
  '/users/:id',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const { role } = req.body || {};
    if (!role) {
      throw errors.validation('role is required.', 'role');
    }
    const user = await adminUserService.updateAdminUserRole(req.params.id, role, req.admin.id);
    res.json(user);
  }),
);

router.delete(
  '/users/:id',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const result = await adminUserService.deleteAdminUser(req.params.id, req.admin.id);
    res.json(result);
  }),
);

// --- Accounts ---

router.get(
  '/accounts',
  asyncHandler(async (req, res) => {
    res.json(await adminService.listAccounts({ ...req.query, tenantId: tenantScope(req) }));
  }),
);

router.get(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    res.json(await accountService.getAccountById(req.params.id));
  }),
);

// Call + message history for an account — { calls, messages }, limit/offset.
router.get(
  '/accounts/:id/history',
  asyncHandler(async (req, res) => {
    const { limit, offset } = req.query;
    const tenantId = tenantScope(req);
    const [calls, messages] = await Promise.all([
      cdrService.getCallHistory(req.params.id, { limit, offset }, tenantId),
      cdrService.getMessageHistory(req.params.id, { limit, offset }, tenantId),
    ]);
    res.json({ calls, messages });
  }),
);

// Voicemails for an account (admin + super_admin).
router.get(
  '/accounts/:id/voicemails',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const { limit, offset } = req.query;
    const voicemails = await voicemailService.getVoicemails(
      req.params.id,
      { limit, offset },
      tenantScope(req),
    );
    res.json({ voicemails });
  }),
);

// Signed recording URL — 302 redirect, or ?format=json → { url } for the SPA
// audio player (which can't send an auth header).
router.get(
  '/voicemails/:id/recording',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const voicemail = await voicemailService.getById(req.params.id, {
      tenantId: tenantScope(req),
    });
    if (!voicemail) throw errors.notFound('Voicemail not found.');
    const url = await s3.signedUrlForVoicemail(voicemail, 3600);
    if (!url) throw errors.notFound('No recording available.');
    if (req.query.format === 'json') {
      res.json({ url });
      return;
    }
    res.redirect(302, url);
  }),
);

// Mark a voicemail read.
router.patch(
  '/voicemails/:id/read',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const voicemail = await voicemailService.markAsRead(req.params.id, {
      tenantId: tenantScope(req),
    });
    if (!voicemail) throw errors.notFound('Voicemail not found.');
    res.json(voicemail);
  }),
);

// Delete a voicemail.
router.delete(
  '/voicemails/:id',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const result = await voicemailService.deleteVoicemail(req.params.id, {
      tenantId: tenantScope(req),
    });
    if (!result) throw errors.notFound('Voicemail not found.');
    res.json(result);
  }),
);

// Usage stats for an account (data snapshot + this month's voice/SMS/MMS).
router.get(
  '/accounts/:id/usage',
  asyncHandler(async (req, res) => {
    res.json(await adminService.getAccountUsageStats(req.params.id, tenantScope(req)));
  }),
);

// Backfill/repair sip_password_hash from Telnyx (fixes pre-hash accounts that
// fail Acrobits SIP-credential auth). super_admin only.
router.post(
  '/accounts/:id/refresh-sip-credentials',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const result = await accountService.refreshSipPasswordHash(req.params.id);
    logger.info({ adminId: req.admin.id, accountId: req.params.id }, 'admin refreshed SIP credentials');
    res.json(result);
  }),
);

// eSIM install QR (data URL). With { regenerate: true } it provisions a fresh
// BICS endpoint; otherwise it renders the QR from the stored/live activation
// code. super_admin + admin.
router.post(
  '/accounts/:id/esim-qr',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const regenerate = Boolean(req.body && req.body.regenerate);
    const result = await accountService.getEsimQr(req.params.id, { regenerate });
    logger.info(
      { adminId: req.admin.id, accountId: req.params.id, regenerate },
      'admin generated eSIM QR',
    );
    res.json(result);
  }),
);

// Update account profile fields (name, email). super_admin + admin.
router.post(
  '/accounts/:id/update-profile',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const { first_name: firstName, last_name: lastName, email } = req.body || {};
    if (firstName === undefined && lastName === undefined && email === undefined) {
      throw errors.validation(
        'At least one of first_name, last_name, or email is required.',
        'first_name',
      );
    }
    const account = await accountService.updateAccount(req.params.id, {
      first_name: firstName,
      last_name: lastName,
      email,
    });
    logger.info(
      { adminId: req.admin.id, accountId: req.params.id },
      'admin updated account profile',
    );
    res.json(account);
  }),
);

// Update the full subscriber profile — name, email, address, alt contact.
// super_admin + admin. Body accepts any subset; at least one field required.
const PROFILE_FIELDS = [
  'first_name', 'last_name', 'email',
  'address_line1', 'address_line2', 'city', 'state', 'zip', 'phone_alt',
];
router.patch(
  '/accounts/:id/profile',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const patch = {};
    PROFILE_FIELDS.forEach((field) => {
      if (body[field] !== undefined) patch[field] = body[field];
    });
    if (Object.keys(patch).length === 0) {
      throw errors.validation(
        `At least one profile field is required (${PROFILE_FIELDS.join(', ')}).`,
        'first_name',
      );
    }
    const account = await accountService.updateAccount(req.params.id, patch);
    logger.info(
      { adminId: req.admin.id, accountId: req.params.id, fields: Object.keys(patch) },
      'admin updated subscriber profile',
    );
    res.json(account);
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

// Port-out PIN for CSR support (admin + super_admin). Read-only — the customer
// resets it themselves from the portal.
router.get(
  '/accounts/:id/port-pin',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    res.json(await accountService.getPortPin(req.params.id));
  }),
);

// Dialer provisioning QR (Cloud Softphone deep link with live SIP credentials)
// for CSR-assisted setup (admin + super_admin).
router.get(
  '/accounts/:id/provisioning-qr',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const account = await accountService.getAccountById(req.params.id);
    res.json(await provisioningService.buildProvisioningQr(account));
  }),
);

// Hard-delete an account and all related records (super_admin only). Guarded by
// an explicit X-Confirm-Delete: true header so it can't be triggered casually.
// Releases the DID at Telnyx + deactivates the BICS endpoint (best-effort).
router.delete(
  '/accounts/:id',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    if (req.get('X-Confirm-Delete') !== 'true') {
      throw errors.validation(
        'Account deletion requires the "X-Confirm-Delete: true" header.',
        'confirm',
      );
    }
    const result = await accountService.deleteAccount(req.params.id);
    logger.info({ adminId: req.admin.id, accountId: req.params.id }, 'admin hard-deleted account');
    res.json(result);
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
    res.json(await adminService.listDids({ ...req.query, tenantId: tenantScope(req) }));
  }),
);

// --- Ports ---

router.get(
  '/ports',
  asyncHandler(async (req, res) => {
    res.json(await adminService.listPorts({ ...req.query, tenantId: tenantScope(req) }));
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
    res.json(await adminService.getMetrics(tenantScope(req)));
  }),
);

// --- Usage ---

// Current-period usage summary across all subscribers.
router.get(
  '/usage/summary',
  asyncHandler(async (req, res) => {
    res.json(await usageService.getCurrentPeriodSummary({ tenantId: tenantScope(req) }));
  }),
);

// Manually trigger a usage poll (super_admin only); returns the run summary.
router.post(
  '/usage/poll',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const summary = await usageService.pollAllActiveAccounts();
    logger.info(
      { adminId: req.admin.id, polled: summary.polled, failed: summary.failed },
      'admin triggered a manual usage poll',
    );
    res.json(summary);
  }),
);

// --- Analytics ---

// Network activity (calls + messages) by hour of day, current month.
router.get(
  '/analytics/hourly-activity',
  asyncHandler(async (req, res) => {
    res.json(await adminService.getHourlyActivity(tenantScope(req)));
  }),
);

// Subscriber data-usage distribution across GB buckets.
router.get(
  '/analytics/usage-distribution',
  asyncHandler(async (req, res) => {
    res.json(await adminService.getUsageDistribution(tenantScope(req)));
  }),
);

// Voice minutes + call volume (data-activity proxy) by hour, current month.
router.get(
  '/analytics/hourly-data-voice',
  asyncHandler(async (req, res) => {
    res.json(await adminService.getHourlyDataVoice(tenantScope(req)));
  }),
);

// Message volume by hour split by direction (sent/received), current month.
router.get(
  '/analytics/hourly-messages',
  asyncHandler(async (req, res) => {
    res.json(await adminService.getHourlyMessages(tenantScope(req)));
  }),
);

// Total data usage over time, bucketed by day (30) / week (12) / month (12).
router.get(
  '/analytics/usage-trends',
  asyncHandler(async (req, res) => {
    const period = ['day', 'week', 'month'].includes(req.query.period)
      ? req.query.period
      : 'day';
    res.json(await adminService.getUsageTrends(period, tenantScope(req)));
  }),
);

// Billing reconciliation for a date range: Telnyx volumes vs BICS data usage.
router.get(
  '/analytics/billing-reconciliation',
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    if (!isDate(from) || !isDate(to)) {
      throw errors.validation('from and to are required as YYYY-MM-DD dates.', 'from');
    }
    res.json(await adminService.getBillingReconciliation(from, to, tenantScope(req)));
  }),
);

module.exports = router;
