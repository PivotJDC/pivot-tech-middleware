/**
 * Auth routes (mounted at /v1/auth).
 *
 *   POST /v1/auth/token        { email } -> { token, account_id, ... }  (legacy)
 *   POST /v1/auth/send-code    { email } -> { sent: true }  (passwordless step 1)
 *   POST /v1/auth/verify-code  { email, code } -> { token, account }  (step 2)
 *
 * Passwordless login: send-code stores (and currently logs) a 6-digit code with
 * a 10-minute TTL; verify-code exchanges a valid code for a 24h customer JWT.
 * send-code never reveals whether the email maps to an account.
 *
 * The legacy /token endpoint issues a JWT with no proof of email ownership and
 * is kept only until clients move to the code flow.
 */
const express = require('express');
const accountService = require('../../services/accountService');
const authService = require('../../services/authService');
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
    const jwt = token.signCustomerToken({ sub: account.id, tenant_id: account.tenant_id });
    res.json({
      token: jwt,
      account_id: account.id,
      token_type: 'Bearer',
      expires_in: 24 * 60 * 60,
    });
  }),
);

// Passwordless step 1: issue a 6-digit code. Always 200 { sent: true } so the
// response never reveals whether the email maps to an account.
router.post(
  '/send-code',
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!email) {
      throw errors.validation('email is required.', 'email');
    }
    await authService.sendCode(email);
    res.json({ sent: true });
  }),
);

// Passwordless step 2: exchange a valid code for a customer JWT + account.
router.post(
  '/verify-code',
  asyncHandler(async (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) {
      throw errors.validation('email and code are required.');
    }
    const result = await authService.verifyCode(email, code);
    if (!result) {
      throw errors.unauthorized('Invalid or expired code.');
    }
    res.json({ token: result.token, account: result.account });
  }),
);

module.exports = router;
