/**
 * Acrobits integration — generates the Account XML the Cloud Softphone app
 * fetches from GET /v1/provision (CLAUDE.md "Acrobits Provisioning").
 *
 * This is the one place the plaintext SIP password is rendered into a response.
 * Callers must pass it in memory only; it is never logged or persisted here.
 */
const config = require('../config');
const { formatNational } = require('../utils/e164');

// DECISION: Jim's migration note pointed at provisioningService.js, but the
// provisioning XML domain is actually constructed here. Telnyx uses a single
// shared SIP domain (no per-customer space like SignalWire), so this is now a
// constant rather than derived from config.
// eslint-disable-next-line no-unused-vars -- TEST: domain temporarily omitted from Account XML
const SIP_DOMAIN = 'sip.telnyx.com';

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
 * SIP identity is split across two fields (confirmed against the Acrobits
 * Account XML docs):
 *   - <username>     the user part of the SIP URI / From header. We use the
 *                    subscriber's E.164 number so outbound calls present the
 *                    subscriber's own caller identity.
 *   - <authUsername> the username used ONLY in SIP authorization (digest)
 *                    headers — the Telnyx-generated gencred credential. Acrobits
 *                    docs: "Username used in SIP authorization headers. If left
 *                    empty, the username is used." Leaving it empty would
 *                    (incorrectly) authenticate as the E.164 number, so it must
 *                    be set explicitly.
 * Both fields used to be the gencred credential, which put the gencred in the
 * From header instead of the subscriber's number (the bug fixed here).
 *
 * Per-subscriber caller ID:
 *   - callerIdName   = "{firstName} {lastName}" → the From-header display name
 *                      (rendered as <displayName>). Falls back to the
 *                      national-format number when the subscriber has no name.
 *   - callerIdNumber = phoneE164 → the From-header number (rendered as
 *                      <callerID>).
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
  // const domain = SIP_DOMAIN; // TEST: let the portal's SIP settings apply
  // Caller ID display name = subscriber's full name; fall back to the
  // national-format number when no name is on file (name fields are optional).
  const callerIdName = [firstName, lastName]
    .filter((part) => part && String(part).trim())
    .join(' ')
    .trim() || formatNational(phoneE164);
  const callerIdNumber = phoneE164;

  // Generic SMS web services: Cloud Softphone can't bridge SMS/MMS over SIP, so
  // it calls our middleware directly. These are the Acrobits-standard Account
  // XML elements (they take precedence over the portal's Send Message URL,
  // which is left empty). The %account[...]% tokens resolve to <authUsername>
  // and <password> from THIS document; %sms_to%/%sms_body%/%last_known_sms_id%
  // are Acrobits service-specific variables. The URL is XML content so the query
  // separators must be escaped as "&amp;".
  //
  // We send %account[authUsername]% (the Telnyx gencred), not %account[username]%
  // (the subscriber E.164): authAcrobits looks up by sip_username, which is what
  // <authUsername> carries. It also falls back to a phone_e164 lookup.
  const base = (config.provisioning.baseUrl || '').replace(/\/+$/, '');
  const smsSendUrl = `${base}/v1/acrobits/send?username=%account[authUsername]%&amp;password=%account[password]%&amp;to=%sms_to%&amp;body=%sms_body%`;
  const smsFetchUrl = `${base}/v1/acrobits/fetch?username=%account[authUsername]%&amp;password=%account[password]%&amp;last_known=%last_known_sms_id%`;

  // NB: transport is UDP with no SRTP — TLS/SRTP broke SIP registration.
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<account>',
    `  <username>${escapeXml(phoneE164)}</username>`,
    `  <authUsername>${escapeXml(sipUsername)}</authUsername>`,
    `  <password>${escapeXml(sipPassword)}</password>`,
    // TEST: omit domain/port/transport so the portal's SIP settings control
    // transport instead of this XML overriding them.
    // `  <domain>${escapeXml(domain)}</domain>`,
    // '  <port>5060</port>',
    // '  <transport>UDP</transport>',
    '  <title>Pivot-Tech</title>',
    '  <allowMessage>1</allowMessage>',
    '  <allowVideo>1</allowVideo>',
    '  <pushEnabled>0</pushEnabled>',
    `  <displayName>${escapeXml(callerIdName)}</displayName>`,
    `  <callerID>${escapeXml(callerIdNumber)}</callerID>`,
    '  <codecPriority>OPUS,ULAW,ALAW</codecPriority>',
    `  <genericSmsSendUrl>${smsSendUrl}</genericSmsSendUrl>`,
    `  <genericSmsFetchUrl>${smsFetchUrl}</genericSmsFetchUrl>`,
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
    '      </actions>',
    '    </rule>',
    '  </rewriting>',
    '</account>',
    '',
  ].join('\n');
}

module.exports = { buildAccountXml, escapeXml };
