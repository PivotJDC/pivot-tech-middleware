/**
 * Customer number-porting routes (mounted at /v1/port). FastPort Phase 1.
 *
 *   POST /v1/port/check    portability lookup (public — used pre-signup)
 *   POST /v1/port/create   open a port for the authenticated subscriber
 *   GET  /v1/port/status   my current port order
 *   POST /v1/port/cancel   cancel my in-progress port
 *
 * /check is public (it only proxies a Telnyx portability lookup and stores
 * nothing) so the signup flow can gate on it before an account exists; it is
 * rate-limited to blunt abuse. The other routes act on the token subject
 * (req.auth.accountId) — a customer can only touch their own port.
 *
 * The account number and transfer PIN submitted to /create are never returned or
 * logged; portService encrypts them at rest (CLAUDE.md rules #1/#2).
 */
const express = require('express');
const portService = require('../../services/portService');
const { authenticate } = require('../../middleware/auth');
const { rateLimit } = require('../../middleware/rateLimiter');
const { asyncHandler } = require('../../middleware/errorHandler');

const router = express.Router();

router.post(
  '/check',
  rateLimit({ windowMs: 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    const { phone_number: phoneNumber } = req.body || {};
    res.json(await portService.checkPortability(phoneNumber));
  }),
);

router.post(
  '/create',
  authenticate,
  asyncHandler(async (req, res) => {
    const {
      phone_number: phoneNumber,
      account_number: accountNumber,
      pin,
      auth_name: authName,
      service_address: serviceAddress,
    } = req.body || {};
    const order = await portService.createPort(req.auth.accountId, {
      phoneNumber, accountNumber, pin, authName, serviceAddress,
    });
    res.status(201).json(order);
  }),
);

router.get(
  '/status',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await portService.getPortStatus(req.auth.accountId));
  }),
);

router.post(
  '/cancel',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await portService.cancelPort(req.auth.accountId));
  }),
);

module.exports = router;
