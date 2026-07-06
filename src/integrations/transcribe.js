/**
 * AWS Transcribe integration — voicemail speech-to-text.
 *
 * We start a transcription job on a voicemail recording (already archived to
 * S3) and write the result JSON back to the same bucket at
 * transcripts/{voicemailId}.json. The job runs async (10-30s); the caller polls
 * getTranscriptionResult until it COMPLETEs, then reads the transcript text.
 *
 * The client is created lazily so importing this module needs no AWS creds
 * until a transcription actually runs (region from the standard AWS chain).
 *
 * IAM: the App Runner instance role needs transcribe:StartTranscriptionJob and
 * transcribe:GetTranscriptionJob, plus s3:GetObject on the recordings bucket.
 */
const {
  TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand,
} = require('@aws-sdk/client-transcribe');
const config = require('../config');
const s3 = require('./s3');
const { logger } = require('../utils/logger');

let client;

function getClient() {
  if (!client) {
    client = new TranscribeClient({ region: config.aws.region });
  }
  return client;
}

/** Deterministic (unique) job name + transcript key from a voicemail id. */
function jobNameFor(voicemailId) {
  return `vm-${voicemailId}`;
}
function transcriptKeyFor(voicemailId) {
  return `transcripts/${voicemailId}.json`;
}

/**
 * Start a transcription job for a voicemail recording.
 * @param {string} s3Key - the recording object key in the recordings bucket.
 * @param {string} voicemailId
 * @returns {Promise<string>} the transcription job name.
 */
async function startTranscription(s3Key, voicemailId) {
  const jobName = jobNameFor(voicemailId);
  await getClient().send(new StartTranscriptionJobCommand({
    TranscriptionJobName: jobName,
    LanguageCode: 'en-US',
    MediaFormat: 'wav',
    Media: { MediaFileUri: `s3://${s3.bucket()}/${s3Key}` },
    OutputBucketName: s3.bucket(),
    OutputKey: transcriptKeyFor(voicemailId),
  }));
  logger.info({ jobName, voicemailId }, 'voicemail transcription job started');
  return jobName;
}

/**
 * Poll a transcription job. Returns { status, text } — text is the transcript
 * string when COMPLETED (read from the output JSON in S3), else null.
 * @param {string} jobName
 * @returns {Promise<{ status: string, text: string|null }>}
 */
async function getTranscriptionResult(jobName) {
  const { TranscriptionJob } = await getClient().send(
    new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
  );
  const status = (TranscriptionJob && TranscriptionJob.TranscriptionJobStatus) || 'UNKNOWN';
  if (status !== 'COMPLETED') return { status, text: null };

  const voicemailId = jobName.replace(/^vm-/, '');
  let text = '';
  try {
    const raw = await s3.getObjectText(transcriptKeyFor(voicemailId));
    const parsed = JSON.parse(raw);
    text = (parsed.results && parsed.results.transcripts && parsed.results.transcripts[0]
      && parsed.results.transcripts[0].transcript) || '';
  } catch (err) {
    logger.error({ jobName, err: err.message }, 'failed to read transcription result');
    text = '';
  }
  return { status, text };
}

module.exports = {
  startTranscription,
  getTranscriptionResult,
  jobNameFor,
  transcriptKeyFor,
};
