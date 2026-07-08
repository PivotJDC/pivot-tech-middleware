/**
 * Acrobits integration — generates the Account XML the Cloud Softphone app
 * fetches from GET /v1/provision (CLAUDE.md "Acrobits Provisioning").
 *
 * This is the one place the plaintext SIP password is rendered into a response.
 * Callers must pass it in memory only; it is never logged or persisted here.
 */
const config = require('../config');
const { formatNational } = require('../utils/e164');

/** Escape the five XML special characters so values can't break the document. */
function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (ch) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[ch]));
}

/**
 * Build the Acrobits Account XML.
 *
 * SIP identity:
 *   - <username>     the SIP account username used for REGISTER — it must match
 *                    what Telnyx expects, i.e. the Telnyx-generated gencred
 *                    credential username (sipUsername). Using the E.164 number
 *                    here breaks registration.
 *   - <authUsername> the username used in SIP authorization (digest) headers —
 *                    also the gencred credential, so it matches <username>.
 * The subscriber's E.164 number is carried by <fromUser> and <displayName>
 * (below) for outbound caller-ID display, not by <username>.
 *
 * Per-subscriber caller ID:
 *   - callerIdName   = "{firstName} {lastName}" → the From-header display name
 *                      (rendered as <displayName>). Falls back to the
 *                      national-format number when the subscriber has no name.
 *   - phoneE164      → the From-header user, rendered as <fromUser> (the
 *                      recognized Acrobits property; <callerID> is not one).
 * @param {{ sipUsername: string, sipPassword: string, phoneE164: string,
 *          firstName?: string, lastName?: string }} params
 *   sipUsername is the Telnyx gencred credential (SIP auth only); phoneE164 is
 *   the subscriber's number (the SIP identity / caller ID number); firstName +
 *   lastName form the caller ID display name.
 * @returns {string} XML document (Content-Type: application/xml)
 */
function buildAccountXml({
  sipUsername, sipPassword, phoneE164, firstName, lastName,
}) {
  // Caller ID display name = subscriber's full name; fall back to the
  // national-format number when no name is on file (name fields are optional).
  const callerIdName = [firstName, lastName]
    .filter((part) => part && String(part).trim())
    .join(' ')
    .trim() || formatNational(phoneE164);

  // Generic SMS web services: Cloud Softphone can't bridge SMS/MMS over SIP, so
  // it calls our middleware directly. The %account[...]% tokens resolve to
  // <authUsername> and <password> from THIS document; %sms_to%/%sms_body%/
  // %last_known_sms_id% are Acrobits service-specific variables. The URL is XML
  // content so the query separators must be escaped as "&amp;". We send
  // %account[authUsername]% (the Telnyx gencred), which is what authAcrobits
  // keys on via sip_username (with a phone_e164 fallback).
  const base = (config.provisioning.baseUrl || '').replace(/\/+$/, '');
  const smsSendUrl = `${base}/v1/acrobits/send?username=%account[authUsername]%&amp;password=%account[password]%&amp;to=%sms_to%&amp;body=%sms_body%`;
  const smsFetchUrl = `${base}/v1/acrobits/fetch?username=%account[authUsername]%&amp;password=%account[password]%&amp;last_known=%last_known_sms_id%`;

  // Push Token Reporter: the app POSTs its push tokens (form-urlencoded) to this
  // URL so we can wake it for inbound messages. %selector%/%pushToken*%/
  // %pushappid_*% are Acrobits push variables; %account[...]% authenticate.
  const pushReporterUrl = `${base}/v1/acrobits/push-token`;
  const pushReporterPostData = 'username=%account[authUsername]%&amp;password=%account[password]%'
    + '&amp;selector=%selector%&amp;pushTokenIncomingCall=%pushTokenIncomingCall%'
    + '&amp;pushTokenOther=%pushTokenOther%&amp;pushappid_incoming_call=%pushappid_incoming_call%'
    + '&amp;pushappid_other=%pushappid_other%';

  // Set the subscriber's own E.164 as the SIP asserted identity on every
  // outbound call. Telnyx honors P-Preferred-Identity to derive the caller ID,
  // so calls present the subscriber's number even without an explicit ANI
  // override. The header value is the SUBSCRIBER's number (fixed per account),
  // not the dialed number; the angle brackets are XML-escaped for the attribute.
  const ppiAction = '        <action type="setHeader" param="'
    + `${escapeXml(`P-Preferred-Identity: <sip:${phoneE164}@sip.telnyx.com>`)}"/>`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<account>',
    `  <username>${escapeXml(sipUsername)}</username>`,
    `  <fromUser>${escapeXml(phoneE164)}</fromUser>`,
    `  <authUsername>${escapeXml(sipUsername)}</authUsername>`,
    `  <password>${escapeXml(sipPassword)}</password>`,
    '  <host>sip.telnyx.com</host>',
    '  <transport>udp</transport>',
    '  <title>Pivot-Tech</title>',
    '  <allowMessage>0</allowMessage>',
    '  <allowVideo>1</allowVideo>',
    '  <pushEnabled>1</pushEnabled>',
    `  <displayName>${escapeXml(callerIdName)}</displayName>`,
    '  <codecPriority>OPUS,ULAW,ALAW</codecPriority>',
    `  <genericSmsSendUrl>${smsSendUrl}</genericSmsSendUrl>`,
    `  <genericSmsFetchUrl>${smsFetchUrl}</genericSmsFetchUrl>`,
    `  <pushTokenReporterUrl>${pushReporterUrl}</pushTokenReporterUrl>`,
    `  <pushTokenReporterPostData>${pushReporterPostData}</pushTokenReporterPostData>`,
    '  <pushTokenReporterContentType>application/x-www-form-urlencoded</pushTokenReporterContentType>',
    // Client-side dialed-number rewriting: auto-prepend +1 to 10-digit US
    // numbers and + to 11-digit numbers starting with 1, so calls/SMS are
    // normalized to E.164 on the device before they reach us.
    '  <rewriting>',
    '    <rule>',
    '      <conditions>',
    '        <condition type="doesntStartWith" param="+"/>',
    '        <condition type="lengthEquals" param="10"/>',
    '      </conditions>',
    '      <actions>',
    '        <action type="prepend" param="+1"/>',
    ppiAction,
    '      </actions>',
    '    </rule>',
    '    <rule>',
    '      <conditions>',
    '        <condition type="doesntStartWith" param="+"/>',
    '        <condition type="longerThan" param="10"/>',
    '        <condition type="startsWith" param="1"/>',
    '      </conditions>',
    '      <actions>',
    '        <action type="prepend" param="+"/>',
    ppiAction,
    '      </actions>',
    '    </rule>',
    // Catch-all for numbers already in +E.164 (no prepend needed): still assert
    // the subscriber identity so EVERY outbound call carries the header. Between
    // the three rules the set {10-digit, 11-digit leading 1, +E.164} covers all
    // valid outbound numbers, so exactly one rule fires per call.
    '    <rule>',
    '      <conditions>',
    '        <condition type="startsWith" param="+"/>',
    '      </conditions>',
    '      <actions>',
    ppiAction,
    '      </actions>',
    '    </rule>',
    '  </rewriting>',
    '</account>',
    '',
  ].join('\n');
}

module.exports = { buildAccountXml, escapeXml };
