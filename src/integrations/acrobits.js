/**
 * Acrobits integration — generates the Account XML the Cloud Softphone app
 * fetches from GET /v1/provision (CLAUDE.md "Acrobits Provisioning").
 *
 * This is the one place the plaintext SIP password is rendered into a response.
 * Callers must pass it in memory only; it is never logged or persisted here.
 */
const { formatNational } = require('../utils/e164');

// DECISION: Jim's migration note pointed at provisioningService.js, but the
// provisioning XML domain is actually constructed here. Telnyx uses a single
// shared SIP domain (no per-customer space like SignalWire), so this is now a
// constant rather than derived from config.
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
 * @param {{ sipUsername: string, sipPassword: string, phoneE164: string }} params
 *   sipUsername is the Telnyx gencred credential (SIP auth only); phoneE164 is
 *   the subscriber's number (the SIP identity / caller ID).
 * @returns {string} XML document (Content-Type: application/xml)
 */
function buildAccountXml({ sipUsername, sipPassword, phoneE164 }) {
  const domain = SIP_DOMAIN;
  const displayName = formatNational(phoneE164);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<account>',
    `  <username>${escapeXml(phoneE164)}</username>`,
    `  <authUsername>${escapeXml(sipUsername)}</authUsername>`,
    `  <password>${escapeXml(sipPassword)}</password>`,
    `  <domain>${escapeXml(domain)}</domain>`,
    '  <port>5061</port>',
    '  <transport>TLS</transport>',
    '  <srtp>required</srtp>',
    '  <title>Pivot-Tech</title>',
    '  <allowMessage>1</allowMessage>',
    '  <allowVideo>1</allowVideo>',
    '  <pushEnabled>1</pushEnabled>',
    `  <displayName>${escapeXml(displayName)}</displayName>`,
    `  <callerID>${escapeXml(phoneE164)}</callerID>`,
    '  <codecPriority>OPUS,ULAW,ALAW</codecPriority>',
    '</account>',
    '',
  ].join('\n');
}

module.exports = { buildAccountXml, escapeXml };
