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
    expect(xml).toContain('<port>5061</port>');
    expect(xml).toContain('<transport>TLS</transport>');
    expect(xml).toContain('<srtp>required</srtp>');
    expect(xml).toContain('<callerID>+12085550100</callerID>');
    expect(xml).toContain('<displayName>(208) 555-0100</displayName>');
    expect(xml).toContain('<codecPriority>OPUS,ULAW,ALAW</codecPriority>');
    // The gencred must NOT be the From-header username anymore.
    expect(xml).not.toContain('<username>pivottech-abc</username>');
  });

  it('escapes XML special characters in values', () => {
    const xml = acrobits.buildAccountXml({ ...params, sipPassword: 'a&b<c>"d\'' });
    expect(xml).toContain('<password>a&amp;b&lt;c&gt;&quot;d&apos;</password>');
    expect(xml).not.toContain('a&b<c>');
  });
});
