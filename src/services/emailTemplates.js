/**
 * Transactional email templates. Each returns { subject, text, html }.
 *
 * Kept dependency-free (plain string building) and pure so they're trivial to
 * unit test. HTML values are escaped to avoid breaking the markup if a value
 * ever contains angle brackets/ampersands.
 */

/** Escape the five XML/HTML special characters. */
function esc(value) {
  return String(value == null ? '' : value).replace(/[<>&'"]/g, (ch) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;',
  }[ch]));
}

/** Wrap body HTML in a minimal branded shell. */
function htmlShell(innerHtml) {
  return [
    '<!doctype html>',
    '<html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5;">',
    innerHtml,
    '<p style="color:#9ca3af;font-size:12px;margin-top:24px;">MobilityNet</p>',
    '</body></html>',
  ].join('');
}

/**
 * Invite for a newly created admin user (includes their temporary password).
 * @param {{ username: string, password: string, loginUrl: string }} params
 */
function adminInvite({ username, password, loginUrl }) {
  const subject = "You've been invited as a MobilityNet admin";
  const text = [
    'You have been invited as a MobilityNet admin.',
    '',
    `Username: ${username}`,
    `Temporary password: ${password}`,
    '',
    `Sign in: ${loginUrl}`,
    '',
    'Please sign in and change your password as soon as possible.',
  ].join('\n');
  const html = htmlShell([
    "<h2>You've been invited as a MobilityNet admin</h2>",
    `<p><strong>Username:</strong> ${esc(username)}<br>`,
    `<strong>Temporary password:</strong> ${esc(password)}</p>`,
    `<p><a href="${esc(loginUrl)}">Sign in to the admin console</a></p>`,
    '<p>Please sign in and change your password as soon as possible.</p>',
  ].join(''));
  return { subject, text, html };
}

/**
 * Customer passwordless login code.
 * @param {{ code: string }} params
 */
function customerVerificationCode({ code }) {
  const subject = `Your MobilityNet verification code is: ${code}`;
  const text = [
    `Your MobilityNet verification code is: ${code}`,
    '',
    'This code expires in 10 minutes. If you did not request it, you can ignore this email.',
  ].join('\n');
  const html = htmlShell([
    '<h2>Your MobilityNet verification code</h2>',
    `<p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${esc(code)}</p>`,
    '<p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>',
  ].join(''));
  return { subject, text, html };
}

/**
 * Admin password reset link.
 * @param {{ resetLink: string }} params
 */
function adminPasswordReset({ resetLink }) {
  const subject = 'Reset your MobilityNet admin password';
  const text = [
    'A password reset was requested for your MobilityNet admin account.',
    '',
    `Reset your password: ${resetLink}`,
    '',
    'This link expires in 15 minutes. If you did not request it, you can ignore this email.',
  ].join('\n');
  const html = htmlShell([
    '<h2>Reset your MobilityNet admin password</h2>',
    `<p><a href="${esc(resetLink)}">Reset your password</a></p>`,
    '<p>This link expires in 15 minutes. If you did not request it, you can ignore this email.</p>',
  ].join(''));
  return { subject, text, html };
}

module.exports = {
  adminInvite,
  customerVerificationCode,
  adminPasswordReset,
};
