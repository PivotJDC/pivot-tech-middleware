/**
 * Auth routes (mounted at /v1/auth).
 *
 *   POST /v1/auth/token   { email } -> { token, account_id, token_type, expires_in }
 *
 * MVP token issuance: looks up the account by email and returns a signed RS256
 * customer JWT. There is intentionally NO password/OTP check yet — that hardening
 * (proof of email ownership) is a follow-up. Until then this endpoint is the
 * single way a client obtains the JWT required by the owner-only account routes.
 */
const express = require('express');
const accountService = require('../../services/accountService');
const token = require('../../utils/token');
const { asyncHandler, errors } = require('../../middleware/errorHandler');

const router = express.Router();

router.post(
  '/token',
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!email) {
      throw errors.validation('email is required.', 'email');
    }
    // Throws NOT_FOUND if no matching account — surfaced as a 404.
    const account = await accountService.getAccountByEmail(email);
    const jwt = token.signCustomerToken({ sub: account.id });
    res.json({
      token: jwt,
      account_id: account.id,
      token_type: 'Bearer',
      expires_in: 24 * 60 * 60,
    });
  }),
);

module.exports = router;
