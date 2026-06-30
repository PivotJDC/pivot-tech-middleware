const t = require('../../src/services/emailTemplates');

describe('adminInvite', () => {
  it('includes the username, password, and login URL', () => {
    const { subject, text, html } = t.adminInvite({
      username: 'jim', password: 'temp-pass-1', loginUrl: 'https://mymobilitynet.io/admin',
    });
    expect(subject).toMatch(/invited as a MobilityNet admin/i);
    expect(text).toContain('jim');
    expect(text).toContain('temp-pass-1');
    expect(text).toContain('https://mymobilitynet.io/admin');
    expect(html).toContain('temp-pass-1');
    expect(html).toContain('href="https://mymobilitynet.io/admin"');
  });

  it('HTML-escapes values', () => {
    const { html } = t.adminInvite({
      username: 'a<b>', password: 'p&w"x', loginUrl: 'https://x/admin',
    });
    expect(html).toContain('a&lt;b&gt;');
    expect(html).toContain('p&amp;w&quot;x');
    expect(html).not.toContain('a<b>');
  });
});

describe('customerVerificationCode', () => {
  it('puts the code in the subject and body', () => {
    const { subject, text, html } = t.customerVerificationCode({ code: '123456' });
    expect(subject).toBe('Your MobilityNet verification code is: 123456');
    expect(text).toContain('123456');
    expect(html).toContain('123456');
  });
});

describe('adminPasswordReset', () => {
  it('includes the reset link', () => {
    const link = 'https://mymobilitynet.io/admin/reset-password?token=abc';
    const { subject, text, html } = t.adminPasswordReset({ resetLink: link });
    expect(subject).toBe('Reset your MobilityNet admin password');
    expect(text).toContain(link);
    expect(html).toContain(`href="${link}"`);
  });
});
