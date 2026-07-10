/**
 * Cloud Softphone "Custom Web Tab" API (mounted at /v1/app).
 *
 * These endpoints back the mobile voicemail page that loads inside the Acrobits
 * Cloud Softphone embedded browser. The app has no customer JWT of its own, so it
 * authenticates with the subscriber's SIP credentials (passed from Acrobits
 * template variables) and we mint a short-lived customer JWT for the session.
 *
 *   POST /v1/app/auth        SIP username/password -> customer JWT
 *   GET  /v1/app/voicemails  (JWT) voicemails + transcription + playback URLs
 *
 * SIP-credential auth mirrors the Acrobits messaging web service (authAcrobits):
 * look the account up by its gencred sip_username (or, as a fallback, its E.164)
 * and verify the password against the stored bcrypt hash. Unlike the messaging
 * flow, /auth ALWAYS requires a password — it's a login. The plaintext password
 * is never logged (CLAUDE.md security rule #1). Mark-as-read reuses the existing
 * PATCH /v1/account/voicemails/:id/read (same JWT).
 */
const express = require('express');
const accountService = require('../../services/accountService');
const voicemailService = require('../../services/voicemailService');
const crypto = require('../../utils/crypto');
const token = require('../../utils/token');
const s3 = require('../../integrations/s3');
const { authenticate } = require('../../middleware/auth');
const { rateLimit } = require('../../middleware/rateLimiter');
const { asyncHandler, errors } = require('../../middleware/errorHandler');
const { logger } = require('../../utils/logger');

const router = express.Router();

/**
 * Resolve + verify an account by SIP credentials. Returns the account row, or
 * null when the credentials don't match (never distinguishes "no such user" from
 * "bad password" to the caller).
 */
async function authenticateBySip(username, password) {
  if (!username || !password) return null;
  let account = await accountService.lookupBySipUsername(username);
  if (!account) {
    account = await accountService.lookupByPhoneE164(username);
  }
  if (!account || !account.sip_password_hash) return null;
  const ok = await crypto.verifyPassword(password, account.sip_password_hash);
  return ok ? account : null;
}

/** Shape one voicemail row for the app, with a signed, playable recording URL. */
async function serializeAppVoicemail(vm) {
  let recordingUrl = null;
  try {
    recordingUrl = await s3.signedUrlForVoicemail(vm, 3600);
  } catch (err) {
    logger.warn({ voicemailId: vm.id, err: err.message }, 'failed to sign voicemail recording URL');
  }
  return {
    id: vm.id,
    caller_number: vm.caller_number,
    caller_name: vm.caller_name || null,
    duration_seconds: vm.duration_seconds,
    transcription: vm.transcription || null,
    is_read: vm.is_read,
    created_at: vm.created_at,
    recording_url: recordingUrl,
  };
}

// SIP credentials -> customer JWT. Rate limited to blunt credential stuffing.
router.post(
  '/auth',
  rateLimit({ windowMs: 60_000, max: 10 }),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    const account = await authenticateBySip(username, password);
    if (!account) {
      throw errors.unauthorized('Invalid SIP credentials.');
    }
    const jwt = token.signCustomerToken({ sub: account.id, tenant_id: account.tenant_id });
    logger.info({ accountId: account.id }, 'app auth: minted JWT from SIP credentials');
    res.json({
      token: jwt,
      account_id: account.id,
      phone_e164: account.phone_e164 || null,
    });
  }),
);

// Voicemails (newest first) with full transcription + a signed playback URL,
// plus the unread count. Scoped to the token subject.
router.get(
  '/voicemails',
  authenticate,
  asyncHandler(async (req, res) => {
    const { limit, offset } = req.query;
    const [rows, unread] = await Promise.all([
      voicemailService.getVoicemails(req.auth.accountId, { limit, offset }),
      voicemailService.getVoicemailCount(req.auth.accountId),
    ]);
    const voicemails = await Promise.all(rows.map(serializeAppVoicemail));
    res.json({ voicemails, unread });
  }),
);

module.exports = router;
