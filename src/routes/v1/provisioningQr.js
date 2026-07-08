/**
 * Customer dialer provisioning-QR route (mounted at /v1/account). The account is
 * the authenticated token subject, so a customer can only fetch their own QR.
 *
 *   GET /v1/account/provisioning-qr  -> { qr_url, provisioning_url }
 *
 * The QR encodes a Cloud Softphone deep link carrying the live SIP credentials;
 * it's rendered locally to a data: URL and never logged (security rule #1).
 */
const express = require('express');
const accountService = require('../../services/accountService');
const provisioningService = require('../../services/provisioningService');
const { authenticate } = require('../../middleware/auth');
const { asyncHandler } = require('../../middleware/errorHandler');

const router = express.Router();

router.get(
  '/provisioning-qr',
  authenticate,
  asyncHandler(async (req, res) => {
    const account = await accountService.getAccountById(req.auth.accountId);
    res.json(await provisioningService.buildProvisioningQr(account));
  }),
);

module.exports = router;
