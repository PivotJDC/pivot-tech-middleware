/**
 * Messaging routes (mounted at /v1/messages).
 *
 *   POST /v1/messages                          send an SMS/MMS from your number
 *   GET  /v1/messages                          list your messages (cursor paginated)
 *   GET  /v1/messages/conversation/:number     thread with one number
 *
 * All routes require a valid customer JWT; the authenticated account is the
 * sender/owner (req.auth.accountId) — there is no :id in the path, so the
 * account can only ever act on its own messages. Handlers stay thin; logic
 * lives in messagingService.
 */
const express = require('express');
const messagingService = require('../../services/messagingService');
const { authenticate } = require('../../middleware/auth');
const { asyncHandler } = require('../../middleware/errorHandler');

const router = express.Router();

// Send an SMS/MMS.
router.post(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const { to, body, media_urls: mediaUrls } = req.body || {};
    const message = await messagingService.sendMessage(req.auth.accountId, {
      to,
      body,
      mediaUrls,
    });
    res.status(201).json(message);
  }),
);

// List messages for the authenticated account.
router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const { limit, before } = req.query;
    const messages = await messagingService.getMessages(req.auth.accountId, { limit, before });
    res.json({ messages });
  }),
);

// Conversation thread with a specific number.
router.get(
  '/conversation/:number',
  authenticate,
  asyncHandler(async (req, res) => {
    const { limit, before } = req.query;
    const messages = await messagingService.getConversation(
      req.auth.accountId,
      req.params.number,
      { limit, before },
    );
    res.json({ messages });
  }),
);

module.exports = router;
