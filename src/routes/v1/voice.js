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
const cdrService = require('../../services/cdrService');
const { asyncHandler } = require('../../middleware/errorHandler');
const { verifyTelnyxWebhook } = require('../../middleware/telnyxWebhookVerify');
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

/**
 * TeXML that bridges the call to the subscriber's SIP credential.
 * - timeout="30": give the dialer time to ring (the default can be very short).
 * - answerOnBridge="true": the caller hears the remote ringing instead of
 *   silence until the dialer answers.
 * - callerId: the original PSTN caller's number, so it shows on the device.
 */
function dialXml(sipUsername, from) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Dial timeout="30" answerOnBridge="true" callerId="${escapeXml(from || '')}">`,
    `    <Sip>sip:${escapeXml(sipUsername)}@${SIP_DOMAIN}</Sip>`,
    '  </Dial>',
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
  verifyTelnyxWebhook,
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
    res.send(active ? dialXml(match.sip_username, from) : rejectXml());
  }),
);

/**
 * Normalize a call direction to 'inbound' | 'outbound' | undefined. Handles both
 * the TeXML values (inbound/outbound) and the v2 values (incoming/outgoing) —
 * all of which start with "in"/"out".
 */
function normalizeDirection(raw) {
  const v = String(raw || '').toLowerCase();
  if (v.startsWith('in')) return 'inbound';
  if (v.startsWith('out')) return 'outbound';
  return undefined;
}

// Map a Call Control v2 event_type to our CDR status.
const V2_STATUS_BY_EVENT = {
  'call.initiated': 'initiated',
  'call.answered': 'answered',
  'call.hangup': 'completed',
};

/** Seconds between two ISO timestamps, or 0 when not derivable. */
function durationBetween(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
}

/**
 * Extract a normalized call event from a status webhook. Credential-connection
 * webhooks send Call Control v2 JSON ({ data: { event_type, payload } }); TeXML
 * applications send form-urlencoded (CallSid/CallStatus/...). Handle both.
 */
function parseStatusEvent(body) {
  const data = body && body.data;
  if (data && data.payload) {
    // Call Control v2 JSON.
    const { event_type: eventType } = data;
    const p = data.payload;
    return {
      callSid: p.call_control_id || p.call_session_id || p.call_leg_id || null,
      status: V2_STATUS_BY_EVENT[eventType]
        || (eventType ? String(eventType).replace(/^call\./, '') : null),
      direction: normalizeDirection(p.direction),
      from: normalizePhone(p.from),
      to: normalizePhone(p.to),
      startedAt: p.start_time || null,
      endedAt: p.end_time || null,
      durationSeconds: durationBetween(p.start_time, p.end_time),
    };
  }
  // TeXML form-urlencoded (or flat JSON).
  return {
    callSid: body.CallSid || body.CallControlId || body.call_control_id || null,
    status: body.CallStatus || body.call_status || body.status || null,
    direction: normalizeDirection(body.Direction || body.direction),
    from: normalizePhone(body.From || body.from),
    to: normalizePhone(body.To || body.to),
    startedAt: null,
    endedAt: null,
    durationSeconds:
      Number.parseInt(body.CallDuration || body.Duration || body.call_duration, 10) || 0,
  };
}

// Call status callbacks — log, persist a CDR (best-effort), and acknowledge.
// Accepts both Call Control v2 JSON and TeXML form-urlencoded payloads.
router.post(
  '/status',
  asyncHandler(async (req, res) => {
    const event = parseStatusEvent(req.body || {});
    logger.info({ callId: event.callSid, status: event.status }, 'call status update');

    // Record the call detail. Never let a CDR failure break the webhook ack.
    try {
      await cdrService.recordCall({
        callSid: event.callSid,
        direction: event.direction,
        from: event.from,
        to: event.to,
        status: event.status,
        durationSeconds: event.durationSeconds,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
      });
    } catch (err) {
      logger.error({ err: err.message, callId: event.callSid }, 'failed to record call CDR');
    }

    res.status(200).json({ received: true });
  }),
);

module.exports = router;
