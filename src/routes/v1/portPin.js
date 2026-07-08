/**
 * Customer port-out PIN routes (mounted at /v1/account). The account is always
 * the authenticated token subject — there is no :accountId in the path, so a
 * customer can only see/reset their own PIN.
 *
 *   GET  /v1/account/port-pin        my current port-out PIN
 *   POST /v1/account/port-pin/reset  generate + return a fresh PIN
 *
 * The PIN is what a subscriber gives a new carrier to authorize porting their
 * number away. It's never logged (CLAUDE.md security rule #1).
 */
const express = require('express');
const accountService = require('../../services/accountService');
const { authenticate } = require('../../middleware/auth');
const { asyncHandler } = require('../../middleware/errorHandler');

const router = express.Router();

router.get(
  '/port-pin',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await accountService.getPortPin(req.auth.accountId));
  }),
);

router.post(
  '/port-pin/reset',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await accountService.resetPortPin(req.auth.accountId));
  }),
);

module.exports = router;
