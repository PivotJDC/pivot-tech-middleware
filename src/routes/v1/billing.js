/**
 * Billing routes (mounted at /v1/billing).
 *
 *   GET /v1/billing/export?year=&month=        full monthly export (JSON) — admin
 *   GET /v1/billing/export/csv?year=&month=    same data as a CSV download — admin
 *   GET /v1/billing/:accountId?year=&month=    one account's summary — owner or admin
 *
 * The static /export* routes are declared before the dynamic /:accountId route
 * so "export" is never captured as an account id. Handlers stay thin; the
 * billing logic lives in billingExportService.
 */
const express = require('express');
const billingExportService = require('../../services/billingExportService');
const { adminAuth, verifyAdminToken } = require('../../middleware/adminAuth');
const { asyncHandler, errors } = require('../../middleware/errorHandler');
const token = require('../../utils/token');

const router = express.Router();

/** Validate and coerce ?year=&month= into integers (month 1-12). */
function parseYearMonth(req) {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw errors.validation('A valid `year` is required.', 'year');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw errors.validation('A valid `month` (1-12) is required.', 'month');
  }
  return { year, month };
}

/**
 * Allow either the account owner (customer JWT whose sub matches :accountId) or
 * any authenticated admin. Customer and admin tokens use different
 * keys/algorithms, so each is tried in turn.
 */
function ownerOrAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) {
    next(errors.unauthorized('Authentication required.'));
    return;
  }
  const raw = value.trim();

  let customerValid = false;
  try {
    const claims = token.verifyCustomerToken(raw);
    customerValid = true;
    if (claims.sub === req.params.accountId) {
      req.auth = { accountId: claims.sub, claims };
      next();
      return;
    }
  } catch (err) {
    // Not a (valid) customer token — fall through to the admin check.
  }

  try {
    const adminClaims = verifyAdminToken(raw);
    if (adminClaims && adminClaims.sub) {
      req.admin = { id: adminClaims.sub, ...adminClaims };
      next();
      return;
    }
  } catch (err) {
    // Not an admin token either.
  }

  // A valid customer token for the wrong account is forbidden; anything else
  // (missing/forged/expired) is unauthorized.
  next(customerValid
    ? errors.forbidden('You may only access your own billing.')
    : errors.unauthorized('Invalid or expired token.'));
}

// Full monthly export (JSON) — admin only.
router.get(
  '/export',
  adminAuth,
  asyncHandler(async (req, res) => {
    const { year, month } = parseYearMonth(req);
    res.json(await billingExportService.generateMonthlyExport(year, month));
  }),
);

// Full monthly export (CSV download) — admin only.
router.get(
  '/export/csv',
  adminAuth,
  asyncHandler(async (req, res) => {
    const { year, month } = parseYearMonth(req);
    const csv = await billingExportService.exportToCsv(year, month);
    const period = `${year}-${String(month).padStart(2, '0')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="mobilitynet-billing-${period}.csv"`,
    );
    res.send(csv);
  }),
);

// Single-account summary — owner or admin.
router.get(
  '/:accountId',
  ownerOrAdmin,
  asyncHandler(async (req, res) => {
    const { year, month } = parseYearMonth(req);
    const { accountId } = req.params;
    const summary = await billingExportService.getAccountBillingSummary(accountId, year, month);
    if (!summary) {
      throw errors.notFound('No billing data for this account in the requested period.');
    }
    res.json(summary);
  }),
);

module.exports = router;
