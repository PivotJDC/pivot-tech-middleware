const acrobits = require('../../src/integrations/acrobits');

describe('acrobits.buildAccountXml', () => {
  const params = {
    sipUsername: 'pivottech-abc',
    sipPassword: 'sip-secret-123',
    phoneE164: '+12085550100',
  };

  it('renders the Acrobits Account XML with all required fields', () => {
    const xml = acrobits.buildAccountXml(params);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    // Split identity: <username> is the subscriber E.164 (From header), while
    // <authUsername> is the Telnyx gencred (SIP digest auth only).
    expect(xml).toContain('<username>+12085550100</username>');
    expect(xml).toContain('<authUsername>pivottech-abc</authUsername>');
    expect(xml).toContain('<password>sip-secret-123</password>');
    expect(xml).toContain('<domain>sip.telnyx.com</domain>');
    // UDP without SRTP — TLS/SRTP broke SIP registration.
    expect(xml).toContain('<port>5060</port>');
    expect(xml).toContain('<transport>UDP</transport>');
    expect(xml).not.toContain('<srtp>');
    expect(xml).not.toContain('<transport>TLS</transport>');
    expect(xml).not.toContain('<port>5061</port>');
    expect(xml).toContain('<callerID>+12085550100</callerID>');
    expect(xml).toContain('<displayName>(208) 555-0100</displayName>');
    expect(xml).toContain('<codecPriority>OPUS,ULAW,ALAW</codecPriority>');
    // The gencred must NOT be the From-header username anymore.
    expect(xml).not.toContain('<username>pivottech-abc</username>');
  });

  it('embeds the generic SMS web-service URLs with Acrobits template variables', () => {
    const xml = acrobits.buildAccountXml(params);
    // The legacy <httpMessaging> wrapper is gone; use the standard elements.
    expect(xml).not.toContain('<httpMessaging>');
    const config = require('../../src/config'); // eslint-disable-line global-require
    const base = config.provisioning.baseUrl;
    // %account[authUsername]% (gencred) + %account[password]% resolve from this
    // same Account XML; & separators are XML-escaped as &amp;.
    expect(xml).toContain(
      `<genericSmsSendUrl>${base}/v1/acrobits/send?username=%account[authUsername]%`
      + '&amp;password=%account[password]%&amp;to=%sms_to%&amp;body=%sms_body%'
      + '</genericSmsSendUrl>',
    );
    expect(xml).toContain(
      `<genericSmsFetchUrl>${base}/v1/acrobits/fetch?username=%account[authUsername]%`
      + '&amp;password=%account[password]%&amp;last_known=%last_known_sms_id%'
      + '</genericSmsFetchUrl>',
    );
    // Must send the gencred, not the subscriber E.164.
    expect(xml).not.toContain('%account[username]%');
    // Raw unescaped ampersands would break the XML document.
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|apos;|quot;)/);
  });

  it('escapes XML special characters in values', () => {
    const xml = acrobits.buildAccountXml({ ...params, sipPassword: 'a&b<c>"d\'' });
    expect(xml).toContain('<password>a&amp;b&lt;c&gt;&quot;d&apos;</password>');
    expect(xml).not.toContain('a&b<c>');
  });

  it('uses the subscriber first + last name as the caller ID display name', () => {
    const xml = acrobits.buildAccountXml({ ...params, firstName: 'Jane', lastName: 'Doe' });
    expect(xml).toContain('<displayName>Jane Doe</displayName>');
    // Caller ID number stays the subscriber E.164.
    expect(xml).toContain('<callerID>+12085550100</callerID>');
  });

  it('escapes XML special characters in the caller ID display name', () => {
    const xml = acrobits.buildAccountXml({ ...params, firstName: 'Tom & Jerry', lastName: '<Co>' });
    expect(xml).toContain('<displayName>Tom &amp; Jerry &lt;Co&gt;</displayName>');
  });

  it('falls back to the national-format number when no name is on file', () => {
    const xml = acrobits.buildAccountXml(params); // no firstName/lastName
    expect(xml).toContain('<displayName>(208) 555-0100</displayName>');
  });
});
