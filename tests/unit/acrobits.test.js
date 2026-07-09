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
    // The subscriber's E.164 IS the SIP username — both <username> (SIP From /
    // caller ID) and <authUsername> (digest auth) are the phone number. No gencred.
    expect(xml).toContain('<username>+12085550100</username>');
    expect(xml).toContain('<authUsername>+12085550100</authUsername>');
    expect(xml).toContain('<password>sip-secret-123</password>');
    // Correct Account XML property names: <host> (not <domain>), lowercase
    // transport, and NO <port> element.
    expect(xml).toContain('<host>sip.telnyx.com</host>');
    expect(xml).toContain('<transport>udp</transport>');
    expect(xml).not.toContain('<domain>');
    expect(xml).not.toContain('<port>');
    expect(xml).not.toContain('<srtp>');
    expect(xml).toContain('<pushEnabled>1</pushEnabled>');
    // SIMPLE messaging off — messaging runs via genericSmsSendUrl, not SIP SIMPLE.
    expect(xml).toContain('<allowMessage>0</allowMessage>');
    // Outbound From-header user is the E.164, via <fromUser> (not <callerID>,
    // which isn't a recognized Acrobits Account XML property).
    expect(xml).toContain('<fromUser>+12085550100</fromUser>');
    expect(xml).not.toContain('<callerID>');
    expect(xml).toContain('<displayName>(208) 555-0100</displayName>');
    expect(xml).toContain('<codecPriority>OPUS,ULAW,ALAW</codecPriority>');
    // No gencred anywhere — the phone number is the sole SIP identity.
    expect(xml).not.toContain('pivottech-abc');
  });

  it('embeds the generic SMS web-service URLs with Acrobits template variables', () => {
    const xml = acrobits.buildAccountXml(params);
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

  it('embeds the Push Token Reporter URL, post-data, and content type', () => {
    const xml = acrobits.buildAccountXml(params);
    const config = require('../../src/config'); // eslint-disable-line global-require
    const base = config.provisioning.baseUrl;
    expect(xml).toContain(
      `<pushTokenReporterUrl>${base}/v1/acrobits/push-token</pushTokenReporterUrl>`,
    );
    expect(xml).toContain(
      '<pushTokenReporterPostData>username=%account[authUsername]%'
      + '&amp;password=%account[password]%&amp;selector=%selector%'
      + '&amp;pushTokenIncomingCall=%pushTokenIncomingCall%&amp;pushTokenOther=%pushTokenOther%'
      + '&amp;pushappid_incoming_call=%pushappid_incoming_call%&amp;pushappid_other=%pushappid_other%'
      + '</pushTokenReporterPostData>',
    );
    expect(xml).toContain(
      '<pushTokenReporterContentType>application/x-www-form-urlencoded</pushTokenReporterContentType>',
    );
    // Still no raw unescaped ampersands anywhere in the document.
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|apos;|quot;)/);
  });

  it('includes client-side number rewriting rules for E.164 normalization', () => {
    const xml = acrobits.buildAccountXml(params);
    expect(xml).toContain('<rewriting>');
    // 10-digit US number → prepend +1.
    expect(xml).toContain('<condition type="lengthEquals" param="10"/>');
    expect(xml).toContain('<action type="prepend" param="+1"/>');
    // 11-digit number starting with 1 → prepend +.
    expect(xml).toContain('<condition type="longerThan" param="10"/>');
    expect(xml).toContain('<condition type="startsWith" param="1"/>');
    expect(xml).toContain('<action type="prepend" param="+"/>');
    expect(xml).toContain('</rewriting>');
  });

  it('asserts the subscriber identity via P-Preferred-Identity on outbound calls', () => {
    const xml = acrobits.buildAccountXml(params);
    // Header value is the subscriber's own E.164; angle brackets XML-escaped.
    expect(xml).toContain(
      '<action type="setHeader" param="P-Preferred-Identity: '
      + '&lt;sip:+12085550100@sip.telnyx.com&gt;"/>',
    );
    // Applied to every outbound call — one setHeader per rewriting rule
    // (10-digit, 11-digit-leading-1, already-+E.164).
    const count = (xml.match(/type="setHeader"/g) || []).length;
    expect(count).toBe(3);
    // A catch-all rule for numbers already in +E.164.
    expect(xml).toContain('<condition type="startsWith" param="+"/>');
  });

  it('escapes XML special characters in values', () => {
    const xml = acrobits.buildAccountXml({ ...params, sipPassword: 'a&b<c>"d\'' });
    expect(xml).toContain('<password>a&amp;b&lt;c&gt;&quot;d&apos;</password>');
    expect(xml).not.toContain('a&b<c>');
  });

  it('uses the subscriber first + last name as the caller ID display name', () => {
    const xml = acrobits.buildAccountXml({ ...params, firstName: 'Jane', lastName: 'Doe' });
    expect(xml).toContain('<displayName>Jane Doe</displayName>');
    // From-header user stays the subscriber E.164.
    expect(xml).toContain('<fromUser>+12085550100</fromUser>');
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
