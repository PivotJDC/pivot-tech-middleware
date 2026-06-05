/**
 * Customer account routes (mounted at /v1/accounts).
 *
 *   POST   /v1/accounts            create account (public signup)
 *   GET    /v1/accounts/:id        get account detail (owner only)
 *   PATCH  /v1/accounts/:id        update email/status (owner only)
 *   GET    /v1/accounts/:id/status lightweight status poll (owner only)
 *
 * Account creation is unauthenticated (signup); the other routes require a
 * valid customer JWT whose subject matches :id (authenticate + requireSelf).
 * Handlers stay thin — validation and business rules live in accountService.
 */
const express = require('express');
const accountService = require('../../services/accountService');
const { authenticate, requireSelf } = require('../../middleware/auth');
const { asyncHandler } = require('../../middleware/errorHandler');

const router = express.Router();

// Create account — public signup.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { email, market, plan } = req.body || {};
    const account = await accountService.createAccount({ email, market, plan });
    res.status(201).json(account);
  }),
);

// Get account detail — owner only.
router.get(
  '/:id',
  authenticate,
  requireSelf,
  asyncHandler(async (req, res) => {
    const account = await accountService.getAccountById(req.params.id);
    res.json(account);
  }),
);

// Update account (email and/or status) — owner only.
router.patch(
  '/:id',
  authenticate,
  requireSelf,
  asyncHandler(async (req, res) => {
    const { email, status } = req.body || {};
    const account = await accountService.updateAccount(req.params.id, { email, status });
    res.json(account);
  }),
);

// Lightweight status poll — owner only.
router.get(
  '/:id/status',
  authenticate,
  requireSelf,
  asyncHandler(async (req, res) => {
    const status = await accountService.getAccountStatus(req.params.id);
    res.json(status);
  }),
);

module.exports = router;
