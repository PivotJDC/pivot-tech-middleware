/**
 * Voicemail transcription + delivery.
 *
 * Called fire-and-forget from the voicemail-complete webhook (transcription runs
 * async, 10-30s). It transcribes the recording via AWS Transcribe, then:
 *   - stores the transcript on the voicemail row,
 *   - delivers it to the subscriber's Messages tab (messages table, threaded
 *     with the caller) + logs a voicemail CDR (message_records),
 *   - pushes a notification with the transcript preview.
 *
 * Best-effort throughout: any failure is logged and the subscriber still gets a
 * push. Never throws.
 */
const config = require('../config');
const transcribe = require('../integrations/transcribe');
const s3 = require('../integrations/s3');
const voicemailService = require('./voicemailService');
const messagingService = require('./messagingService');
const cdrService = require('./cdrService');
const pushService = require('./pushService');
const { formatNational } = require('../utils/e164');
const { logger } = require('../utils/logger');

const PREVIEW_MAX = 120;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Poll a Transcribe job until COMPLETED/FAILED or attempts run out. */
async function pollForTranscript(jobName) {
  const { pollIntervalMs, maxPollAttempts } = config.transcribe;
  let attempt = 0;
  while (attempt < maxPollAttempts) {
    // eslint-disable-next-line no-await-in-loop
    const { status, text } = await transcribe.getTranscriptionResult(jobName);
    if (status === 'COMPLETED') return text;
    if (status === 'FAILED') return null;
    attempt += 1;
    if (attempt < maxPollAttempts) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollIntervalMs);
    }
  }
  return null;
}

/** Deliver a transcribed voicemail to Messages (app thread + CDR). */
async function deliverToMessages({
  voicemail, account, from, durationSeconds, text,
}) {
  const body = `🎙️ Voicemail (${durationSeconds}s): ${text}`;
  // messages table → the Acrobits Messages tab, threaded with the caller.
  await messagingService.recordInboundMessage({
    accountId: account.id,
    from,
    to: account.phone_e164,
    body,
    createdAt: voicemail.created_at,
  });
  // message_records CDR (message_type='voicemail') → dashboard history/audit.
  await cdrService.recordVoicemail({
    messageId: voicemail.id,
    accountId: account.id,
    tenantId: account.tenant_id,
    from,
    to: account.phone_e164,
    createdAt: voicemail.created_at,
  });
}

/** Push a notification — transcript preview when available, else generic. */
async function pushNotification({
  account, from, durationSeconds, text, voicemailId,
}) {
  const caller = formatNational(from) || from;
  const body = text
    ? `Voicemail from ${caller}: ${text.substring(0, PREVIEW_MAX)}`
    : `New voicemail (${durationSeconds}s)`;
  await pushService.sendMessagePush(account.id, {
    from, body, messageId: voicemailId, streamId: from,
  });
}

/**
 * Transcribe a voicemail, deliver it to Messages, and push. Best-effort.
 * @param {{ voicemail, account, from, s3Key, durationSeconds }} input
 */
async function process({
  voicemail, account, from, s3Key, durationSeconds,
} = {}) {
  let text = null;
  if (config.transcribe.enabled && s3Key && s3.bucket()) {
    try {
      const jobName = await transcribe.startTranscription(s3Key, voicemail.id);
      text = await pollForTranscript(jobName);
      if (text) {
        await voicemailService.attachTranscription({
          accountId: account.id,
          recordingSid: voicemail.recording_sid,
          transcription: text,
        });
        await deliverToMessages({
          voicemail, account, from, durationSeconds, text,
        });
      } else {
        logger.warn({ voicemailId: voicemail.id }, 'voicemail transcription unavailable');
      }
    } catch (err) {
      logger.error(
        { voicemailId: voicemail.id, err: err.message },
        'voicemail transcription/delivery failed',
      );
    }
  }
  try {
    await pushNotification({
      account, from, durationSeconds, text, voicemailId: voicemail.id,
    });
  } catch (err) {
    logger.error({ voicemailId: voicemail.id, err: err.message }, 'voicemail push failed');
  }
}

module.exports = { process };
