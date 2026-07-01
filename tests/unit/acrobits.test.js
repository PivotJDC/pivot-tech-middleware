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

  it('includes HTTP messaging URLs with Acrobits template variables', () => {
    const xml = acrobits.buildAccountXml(params);
    expect(xml).toContain('<httpMessaging>');
    expect(xml).toContain(
      '/v1/acrobits/send?username=%USERNAME%&amp;password=%PASSWORD%'
      + '&amp;to=%TO_NUMBER%&amp;body=%MESSAGE_BODY%',
    );
    expect(xml).toContain(
      '/v1/acrobits/fetch?username=%USERNAME%&amp;password=%PASSWORD%'
      + '&amp;last_known=%LAST_KNOWN_SMS_ID%',
    );
    // URL prefix comes from config.provisioning.baseUrl (default in tests).
    const config = require('../../src/config'); // eslint-disable-line global-require
    expect(xml).toContain(`<sendURL>${config.provisioning.baseUrl}/v1/acrobits/send?`);
    expect(xml).toContain(`<fetchURL>${config.provisioning.baseUrl}/v1/acrobits/fetch?`);
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
