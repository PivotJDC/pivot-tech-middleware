/**
 * Provisioning routes (mounted at /v1/provision).
 *
 *   GET  /v1/provision?token=xxx   -> Acrobits Account XML (application/xml)
 *   POST /v1/provision/reissue     -> admin: reissue a provisioning token (JSON)
 *
 * The GET endpoint is called by the Acrobits app with a single-use token; it
 * returns XML, not JSON. The reissue endpoint is admin-only.
 */
const express = require('express');
const provisioningService = require('../../services/provisioningService');
const { adminAuth } = require('../../middleware/adminAuth');
const { asyncHandler, errors } = require('../../middleware/errorHandler');

const router = express.Router();

// Acrobits provisioning — returns Account XML.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { token } = req.query;
    if (!token) {
      throw errors.validation('A token query parameter is required.', 'token');
    }
    const xml = await provisioningService.provisionByToken(String(token));
    res.type('application/xml').send(xml);
  }),
);

// Admin: reissue a provisioning token (new token + QR/deep link).
router.post(
  '/reissue',
  adminAuth,
  asyncHandler(async (req, res) => {
    const accountId = (req.body || {}).account_id;
    if (!accountId) {
      throw errors.validation('account_id is required.', 'account_id');
    }
    const result = await provisioningService.reissueToken(accountId);
    res.status(201).json(result);
  }),
);

module.exports = router;
