/**
 * Transactional email via Amazon SES (AWS SDK v3).
 *
 * sendEmail() sends from config.email.from. When config.email.enabled is false
 * (the default), it logs the email instead of sending — so dev/test never touch
 * SES and no credentials are required. The SES client is created lazily on first
 * real send so importing this module is side-effect free.
 *
 * Subjects/bodies may contain one-time codes or reset links; we log only the
 * recipient + subject (never the body) to avoid leaking those into logs.
 */
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const config = require('../config');
const { logger } = require('../utils/logger');

let client;

function getClient() {
  if (!client) {
    client = new SESClient({ region: config.aws.region });
  }
  return client;
}

/**
 * Send a transactional email. Returns { sent: boolean, messageId?, skipped? }.
 * Never throws on a missing body part; throws only on an SES failure (so callers
 * who treat email as best-effort can catch it).
 * @param {{ to: string, subject: string, textBody?: string, htmlBody?: string }} params
 */
async function sendEmail({
  to, subject, textBody, htmlBody,
} = {}) {
  if (!to) {
    throw new Error('sendEmail requires a `to` address');
  }

  if (!config.email.enabled) {
    // Delivery disabled — log that an email WOULD have been sent (subject only).
    logger.info({ to, subject, emailDisabled: true }, 'email not sent (EMAIL_ENABLED=false)');
    return { sent: false, skipped: true };
  }

  const body = {};
  if (textBody) body.Text = { Data: textBody, Charset: 'UTF-8' };
  if (htmlBody) body.Html = { Data: htmlBody, Charset: 'UTF-8' };

  const command = new SendEmailCommand({
    Source: config.email.from,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject || '', Charset: 'UTF-8' },
      Body: body,
    },
  });

  const result = await getClient().send(command);
  logger.info({ to, subject, messageId: result.MessageId }, 'email sent via SES');
  return { sent: true, messageId: result.MessageId };
}

/** Test seam: reset the cached SES client. */
function resetClient() {
  client = undefined;
}

module.exports = { sendEmail, resetClient };
