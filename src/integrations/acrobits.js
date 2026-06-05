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
 * @param {{ sipUsername: string, sipPassword: string, phoneE164: string }} params
 * @returns {string} XML document (Content-Type: application/xml)
 */
function buildAccountXml({ sipUsername, sipPassword, phoneE164 }) {
  const domain = `${config.signalwire.space}.sip.signalwire.com`;
  const displayName = formatNational(phoneE164);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<account>',
    `  <username>${escapeXml(sipUsername)}</username>`,
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
