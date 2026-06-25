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

/**
 * Normalize a phone number from a Telnyx webhook. URL encoding mangles the
 * leading "+" of an E.164 number — in a form body it decodes to a space, and in
 * a query string it may arrive as the literal "%2B" — so handle both, then
 * re-add the "+" before we look the number up.
 */
function normalizePhone(raw) {
  if (!raw) return raw;
  const cleaned = String(raw).replace(/%2B/gi, '+').replace(/\s/g, '');
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
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

// Inbound call routing. Always 200 + XML. Telnyx TeXML may call this with GET
// (params in the query string) or POST (form body), so handle both and merge.
router.all(
  '/inbound',
  asyncHandler(async (req, res) => {
    const params = { ...req.query, ...req.body };
    // URL-encoded "+" arrives as a space (body) or %2B (query); normalize both.
    const to = normalizePhone(params.To || params.to);
    const from = normalizePhone(params.From || params.from);
    const callId = params.CallSid || params.CallControlId || params.call_control_id || null;

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
