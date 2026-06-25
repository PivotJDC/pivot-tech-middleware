/**
 * Voice routes (mounted at /v1/voice). Telnyx calls these directly via TeXML,
 * so they are NOT authenticated. Every response is a TeXML XML document and
 * always 200 — Telnyx expects XML it can act on, not an error envelope.
 *
 *   POST /v1/voice/inbound   inbound call → <Dial> the subscriber's SIP cred,
 *                            or <Reject> when the number is unknown/inactive.
 *   POST /v1/voice/status    call status callbacks (answered/completed/failed).
 *
 * Telnyx TeXML posts form-urlencoded (To/From/CallSid) — app.js mounts the
 * urlencoded parser so req.body is populated; JSON bodies also work.
 */
const express = require('express');
const voiceService = require('../../services/voiceService');
const { asyncHandler } = require('../../middleware/errorHandler');
const { logger } = require('../../utils/logger');

const router = express.Router();

// Telnyx's single shared SIP domain (no per-customer space).
const SIP_DOMAIN = 'sip.telnyx.com';

/** Escape the five XML special characters so values can't break the document. */
function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (ch) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[ch]));
}

/** TeXML that bridges the call to the subscriber's SIP credential. */
function dialXml(sipUsername) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Dial>sip:${escapeXml(sipUsername)}@${SIP_DOMAIN}</Dial>`,
    '</Response>',
    '',
  ].join('\n');
}

/** TeXML that rejects the call (unknown number or inactive account). */
function rejectXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Reject reason="busy"/>',
    '</Response>',
    '',
  ].join('\n');
}

// Inbound call routing. Always 200 + XML.
router.post(
  '/inbound',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const to = body.To || body.to;
    const from = body.From || body.from;
    const callId = body.CallSid || body.CallControlId || body.call_control_id || null;

    const match = await voiceService.lookupByCalledNumber(to);
    const active = !!match && match.status === 'active';

    logger.info(
      {
        to, from, callId, matched: !!match, active,
      },
      'inbound call',
    );

    res.type('application/xml').status(200);
    res.send(active ? dialXml(match.sip_username) : rejectXml());
  }),
);

// Call status callbacks — log and acknowledge.
router.post(
  '/status',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    logger.info(
      {
        callId: body.CallSid || body.CallControlId || null,
        status: body.CallStatus || body.call_status || body.status || null,
      },
      'call status update',
    );
    res.status(200).json({ received: true });
  }),
);

module.exports = router;
