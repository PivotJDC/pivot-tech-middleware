/**
 * Customer voicemail routes (mounted at /v1/account). The account is always the
 * authenticated token subject — there is no :accountId in the path, and every
 * operation is scoped to req.auth.accountId so a customer can only see and
 * manage their own voicemails.
 *
 *   GET    /v1/account/voicemails         list my voicemails (+ unread count)
 *   PATCH  /v1/account/voicemails/:id/read  mark one read
 *   DELETE /v1/account/voicemails/:id     delete one
 */
const express = require('express');
const voicemailService = require('../../services/voicemailService');
const { authenticate } = require('../../middleware/auth');
const { asyncHandler, errors } = require('../../middleware/errorHandler');

const router = express.Router();

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
