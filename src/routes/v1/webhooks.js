/**
 * Webhook routes (mounted at /v1/webhooks).
 *
 *   POST /v1/webhooks/port         SignalWire port lifecycle events
 *   POST /v1/webhooks/signalwire   general SignalWire events (calls, SMS/MMS)
 *   POST /v1/webhooks/messaging    Telnyx messaging events (inbound + delivery)
 *
 * SignalWire requests must carry a valid HMAC-SHA256 signature (CLAUDE.md rule
 * #5); invalid signatures are rejected 403 before any processing. The raw body
 * for the HMAC is captured by the express.json verify hook in app.js
 * (req.rawBody).
 *
 * On success we return 200 so the vendor does not retry. A thrown error becomes
 * a 500 via the error handler, which lets the vendor retry transient failures —
 * safe because the handlers are idempotent.
 */
const express = require('express');
const webhookService = require('../../services/webhookService');
const messagingService = require('../../services/messagingService');
const { asyncHandler, errors } = require('../../middleware/errorHandler');
const { verifyTelnyxWebhook } = require('../../middleware/telnyxWebhookVerify');
const { logger } = require('../../utils/logger');

const router = express.Router();

function requireValidSignature(req, res, next) {
  const signature = req.headers['x-signalwire-signature'];
  const rawBody = req.rawBody || Buffer.from('');
  if (!webhookService.verifySignature(rawBody, signature)) {
    logger.warn({ path: req.path }, 'rejected webhook: invalid signature');
    next(errors.forbidden('Invalid webhook signature.'));
    return;
  }
  next();
}

router.post(
  '/port',
  requireValidSignature,
  asyncHandler(async (req, res) => {
    const result = await webhookService.handlePortEvent(req.body || {});
    res.status(200).json({ received: true, ...result });
  }),
);

router.post(
  '/signalwire',
  requireValidSignature,
  asyncHandler(async (req, res) => {
    const result = await webhookService.handleSignalwireEvent(req.body || {});
    res.status(200).json({ received: true, ...result });
  }),
);

// Telnyx messaging events: inbound messages + delivery status. The Ed25519
// signature (telnyx-signature-ed25519 + telnyx-timestamp) is verified first
// (CLAUDE.md rule #5); verification is skipped only when no public key is
// configured (dev/back-compat). We always return 200 so Telnyx doesn't retry;
// processing errors are logged, not surfaced.
router.post(
  '/messaging',
  verifyTelnyxWebhook,
  asyncHandler(async (req, res) => {
    try {
      const result = await messagingService.handleMessagingWebhook(req.body || {});
      res.status(200).json({ received: true, ...result });
    } catch (err) {
      logger.error({ err: err.message }, 'messaging webhook processing error');
      res.status(200).json({ received: true });
    }
  }),
);

module.exports = router;
