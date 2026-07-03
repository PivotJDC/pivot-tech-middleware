/**
 * Customer voicemail routes (mounted at /v1/account). The account is always the
 * authenticated token subject — there is no :accountId in the path, and every
 * operation is scoped to req.auth.accountId so a customer can only see and
 * manage their own voicemails.
 *
 *   GET    /v1/account/voicemails               list my voicemails (+ unread count)
 *   GET    /v1/account/voicemails/:id/recording  signed recording URL (redirect / ?format=json)
 *   PATCH  /v1/account/voicemails/:id/read       mark one read
 *   DELETE /v1/account/voicemails/:id            delete one
 */
const express = require('express');
const voicemailService = require('../../services/voicemailService');
const s3 = require('../../integrations/s3');
const { authenticate } = require('../../middleware/auth');
const { asyncHandler, errors } = require('../../middleware/errorHandler');

const router = express.Router();

/**
 * Respond with a playable recording URL for a voicemail row. A browser <audio>
 * element can't send an Authorization header, so the SPA fetches ?format=json
 * (authenticated) and plays the returned signed S3 URL directly; a plain hit
 * 302-redirects to the signed URL (per spec).
 */
async function serveRecording(req, res, vm) {
  if (!vm) throw errors.notFound('Voicemail not found.');
  const url = await s3.signedUrlForVoicemail(vm, 3600);
  if (!url) throw errors.notFound('No recording available.');
  if (req.query.format === 'json') {
    res.json({ url });
    return;
  }
  res.redirect(302, url);
}

router.get(
  '/voicemails',
  authenticate,
  asyncHandler(async (req, res) => {
    const { limit, offset } = req.query;
    const [voicemails, unread] = await Promise.all([
      voicemailService.getVoicemails(req.auth.accountId, { limit, offset }),
      voicemailService.getVoicemailCount(req.auth.accountId),
    ]);
    res.json({ voicemails, unread });
  }),
);

router.get(
  '/voicemails/:id/recording',
  authenticate,
  asyncHandler(async (req, res) => {
    const vm = await voicemailService.getById(req.params.id, {
      accountId: req.auth.accountId,
    });
    await serveRecording(req, res, vm);
  }),
);

router.patch(
  '/voicemails/:id/read',
  authenticate,
  asyncHandler(async (req, res) => {
    const voicemail = await voicemailService.markAsRead(req.params.id, {
      accountId: req.auth.accountId,
    });
    if (!voicemail) throw errors.notFound('Voicemail not found.');
    res.json(voicemail);
  }),
);

router.delete(
  '/voicemails/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await voicemailService.deleteVoicemail(req.params.id, {
      accountId: req.auth.accountId,
    });
    if (!result) throw errors.notFound('Voicemail not found.');
    res.json(result);
  }),
);

module.exports = router;
