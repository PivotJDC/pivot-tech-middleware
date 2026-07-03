// Set before requiring config (via voice.js) so the DID route is exercisable.
process.env.VOICEMAIL_SYSTEM_DID = '+15550000086';

jest.mock('../../src/services/voiceService');
jest.mock('../../src/services/cdrService');
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/voicemailService');
jest.mock('../../src/services/pushService');
jest.mock('../../src/integrations/email');
jest.mock('../../src/integrations/s3');
// Automock the Telnyx integration so the Ed25519 webhook verifier reads no
// public key (getWebhookPublicKey -> undefined) and skips — no network call.
jest.mock('../../src/integrations/telnyx');
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {},
  },
  REDACT_PATHS: [],
}));

const express = require('express');
const request = require('supertest');
const voiceService = require('../../src/services/voiceService');
const cdrService = require('../../src/services/cdrService');
const accountService = require('../../src/services/accountService');
const voicemailService = require('../../src/services/voicemailService');
const pushService = require('../../src/services/pushService');
const emailClient = require('../../src/integrations/email');
const s3 = require('../../src/integrations/s3');
const voiceRouter = require('../../src/routes/v1/voice');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  // Mirror app.js: urlencoded (TeXML default) + json.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/v1/voice', voiceRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

beforeEach(() => {
  voiceService.lookupByCalledNumber.mockReset();
});

describe('POST /v1/voice/inbound', () => {
  it('routes a self-dial (from === own number) to the voicemail menu', async () => {
    voiceService.lookupByCalledNumber.mockResolvedValueOnce({
      account_id: 'a1', sip_username: 'pivottech-abc', status: 'active', phone_e164: '+12085550100',
    });
    const res = await request(app)
      .post('/v1/voice/inbound')
      .type('form')
      .send({ To: '+12085550100', From: '+12085550100', CallSid: 'CAself' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<Redirect>');
    expect(res.text).toContain('/v1/voice/voicemail-menu?accountId=a1');
    // Did NOT ring the subscriber's own phone.
    expect(res.text).not.toContain('<Dial');
  });

  it('returns <Dial> to the SIP credential for an active account', async () => {
    voiceService.lookupByCalledNumber.mockResolvedValueOnce({
      account_id: 'a1', sip_username: 'pivottech-abc', status: 'active', phone_e164: '+12085550100',
    });
    const res = await request(app)
      .post('/v1/voice/inbound')
      .type('form')
      .send({ To: '+12085550100', From: '+12085550142', CallSid: 'CA1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<Sip>sip:pivottech-abc@sip.telnyx.com</Sip>');
    // Dial carries the ring timeout, answerOnBridge, and the caller's number.
    expect(res.text).toContain('timeout="25"');
    expect(res.text).toContain('answerOnBridge="true"');
    expect(res.text).toContain('callerId="+12085550142"');
    // The Dial action routes an unanswered call to the voicemail handler.
    expect(res.text).toContain('/v1/voice/voicemail-handler?accountId=a1&amp;from=');
    expect(res.text).not.toContain('<Reject');
    expect(voiceService.lookupByCalledNumber).toHaveBeenCalledWith('+12085550100');
  });

  it('returns <Reject> for an unknown number', async () => {
    voiceService.lookupByCalledNumber.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/v1/voice/inbound')
      .type('form')
      .send({ To: '+19999999999', From: '+12085550142', CallSid: 'CA2' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<Reject reason="busy"/>');
    expect(res.text).not.toContain('<Dial>');
  });

  it('returns <Reject> for a suspended account', async () => {
    voiceService.lookupByCalledNumber.mockResolvedValueOnce({
      account_id: 'a1', sip_username: 'pivottech-abc', status: 'suspended',
    });
    const res = await request(app)
      .post('/v1/voice/inbound')
      .type('form')
      .send({ To: '+12085550100', From: '+12085550142', CallSid: 'CA3' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Reject reason="busy"/>');
    expect(res.text).not.toContain('<Dial>');
  });

  it('handles a GET webhook with params in the query string', async () => {
    voiceService.lookupByCalledNumber.mockResolvedValueOnce({
      account_id: 'a1', sip_username: 'pivottech-abc', status: 'active',
    });
    const res = await request(app)
      .get('/v1/voice/inbound')
      .query({ To: '+12085550100', From: '+12085550142', CallSid: 'CA-get' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<Sip>sip:pivottech-abc@sip.telnyx.com</Sip>');
    expect(voiceService.lookupByCalledNumber).toHaveBeenCalledWith('+12085550100');
  });

  it('normalizes a query "To" whose + arrived as %2B', async () => {
    voiceService.lookupByCalledNumber.mockResolvedValueOnce({
      account_id: 'a1', sip_username: 'pivottech-abc', status: 'active',
    });
    // Raw query string with a literal %2B (defensive: handled even if not pre-decoded).
    const res = await request(app)
      .get('/v1/voice/inbound?To=%2B12085550100&From=%2B12085550142&CallSid=CA-enc');
    expect(res.status).toBe(200);
    expect(voiceService.lookupByCalledNumber).toHaveBeenCalledWith('+12085550100');
  });

  it('also accepts a JSON body', async () => {
    voiceService.lookupByCalledNumber.mockResolvedValueOnce({
      account_id: 'a1', sip_username: 'pivottech-xyz', status: 'active',
    });
    const res = await request(app)
      .post('/v1/voice/inbound')
      .send({ To: '+12085550100', From: '+12085550142', CallControlId: 'cc-1' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Sip>sip:pivottech-xyz@sip.telnyx.com</Sip>');
  });

  it('normalizes a number whose URL-encoded "+" arrived as a space', async () => {
    voiceService.lookupByCalledNumber.mockResolvedValueOnce({
      account_id: 'a1', sip_username: 'pivottech-abc', status: 'active',
    });
    // Raw form body: a literal "+" in urlencoded decodes to a space, so the
    // route receives "To= 12085550100" — exactly what Telnyx sends.
    const res = await request(app)
      .post('/v1/voice/inbound')
      .type('form')
      .send('To=+12085550100&From=+12085550142&CallSid=CA9');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Sip>sip:pivottech-abc@sip.telnyx.com</Sip>');
    // The space-mangled number is normalized back to E.164 before lookup.
    expect(voiceService.lookupByCalledNumber).toHaveBeenCalledWith('+12085550100');
  });
});

describe('POST /v1/voice/status', () => {
  beforeEach(() => cdrService.recordCall.mockReset());

  it('acknowledges a status callback with 200 and records a CDR', async () => {
    cdrService.recordCall.mockResolvedValueOnce({ id: 'cr-1' });
    const res = await request(app)
      .post('/v1/voice/status')
      .type('form')
      .send('CallSid=CA1&CallStatus=completed&Direction=outbound&From=+12085550100&To=+12085550142&CallDuration=37');

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(cdrService.recordCall).toHaveBeenCalledWith(expect.objectContaining({
      callSid: 'CA1',
      direction: 'outbound',
      from: '+12085550100',
      to: '+12085550142',
      status: 'completed',
      durationSeconds: 37,
    }));
  });

  it('still acknowledges 200 even if CDR recording throws', async () => {
    cdrService.recordCall.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app)
      .post('/v1/voice/status')
      .type('form')
      .send({ CallSid: 'CA2', CallStatus: 'failed' });
    expect(res.status).toBe(200);
  });

  it('parses Call Control v2 JSON webhooks (credential connection format)', async () => {
    cdrService.recordCall.mockResolvedValueOnce({ id: 'cr-2' });
    const res = await request(app)
      .post('/v1/voice/status')
      .send({
        data: {
          event_type: 'call.hangup',
          payload: {
            call_control_id: 'v3:abc123',
            call_session_id: 'sess-1',
            from: '+12085550142',
            to: '+12085550100',
            direction: 'incoming',
            state: 'hangup',
            start_time: '2026-07-01T00:00:00.000Z',
            end_time: '2026-07-01T00:01:30.000Z',
          },
        },
      });

    expect(res.status).toBe(200);
    expect(cdrService.recordCall).toHaveBeenCalledWith(expect.objectContaining({
      callSid: 'v3:abc123',
      status: 'completed', // call.hangup -> completed
      direction: 'inbound', // incoming -> inbound
      from: '+12085550142',
      to: '+12085550100',
      durationSeconds: 90, // 90s between start and end
      startedAt: '2026-07-01T00:00:00.000Z',
      endedAt: '2026-07-01T00:01:30.000Z',
    }));
  });

  it('maps v2 call.initiated and call.answered events', async () => {
    cdrService.recordCall.mockResolvedValue({ id: 'cr-x' });

    await request(app).post('/v1/voice/status').send({
      data: {
        event_type: 'call.initiated',
        payload: {
          call_control_id: 'c1', from: '+1', to: '+2', direction: 'outgoing',
        },
      },
    });
    expect(cdrService.recordCall).toHaveBeenLastCalledWith(expect.objectContaining({
      callSid: 'c1', status: 'initiated', direction: 'outbound',
    }));

    await request(app).post('/v1/voice/status').send({
      data: {
        event_type: 'call.answered',
        payload: {
          call_control_id: 'c1', from: '+1', to: '+2', direction: 'outgoing',
        },
      },
    });
    expect(cdrService.recordCall).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'answered',
    }));
  });
});

describe('POST /v1/voice/voicemail-handler', () => {
  beforeEach(() => {
    accountService.getAccountById.mockReset();
  });

  it('returns an empty Response when the call was answered (completed)', async () => {
    const res = await request(app)
      .post('/v1/voice/voicemail-handler?accountId=a1&from=%2B12085550142')
      .type('form')
      .send({ DialCallStatus: 'completed' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<Response/>');
    expect(res.text).not.toContain('<Record');
    expect(accountService.getAccountById).not.toHaveBeenCalled();
  });

  it('prompts with <Say> + <Record> on no-answer (no custom greeting)', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: 'a1', first_name: 'Jane', last_name: 'Doe', voicemail_enabled: true,
    });
    const res = await request(app)
      .post('/v1/voice/voicemail-handler?accountId=a1&from=%2B12085550142')
      .type('form')
      .send({ DialCallStatus: 'no-answer' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Say voice="alice">You have reached Jane Doe.');
    expect(res.text).toContain('Or press star to reach the voicemail menu.');
    expect(res.text).toContain('<Record maxLength="120"');
    expect(res.text).toContain('/v1/voice/voicemail-complete?accountId=a1&amp;from=');
    // Transcription attributes are intentionally omitted for now.
    expect(res.text).not.toContain('transcribe=');
    expect(res.text).not.toContain('transcribeCallback=');
    expect(res.text).toContain('Thank you. Goodbye.');
  });

  it('plays a custom greeting from the stored URL fallback', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: 'a1', voicemail_enabled: true, voicemail_greeting_url: 'https://cdn/greet.mp3',
    });
    const res = await request(app)
      .post('/v1/voice/voicemail-handler?accountId=a1&from=%2B1')
      .type('form')
      .send({ DialCallStatus: 'busy' });
    expect(res.text).toContain('<Play>https://cdn/greet.mp3</Play>');
    expect(res.text).not.toContain('<Say voice="alice">You have reached');
  });

  it('plays an archived greeting via a fresh signed S3 URL', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: 'a1', voicemail_enabled: true, voicemail_greeting_s3_key: 'greetings/a1/greeting.wav',
    });
    s3.bucket.mockReturnValueOnce('mobilitynet-recordings');
    s3.getSignedRecordingUrl.mockResolvedValueOnce('https://signed.example/greet');
    const res = await request(app)
      .post('/v1/voice/voicemail-handler?accountId=a1&from=%2B1')
      .type('form')
      .send({ DialCallStatus: 'no-answer' });
    expect(s3.getSignedRecordingUrl).toHaveBeenCalledWith('greetings/a1/greeting.wav', 86400);
    expect(res.text).toContain('<Play>https://signed.example/greet</Play>');
  });

  it('hangs up (empty Response) when voicemail is disabled', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', voicemail_enabled: false });
    const res = await request(app)
      .post('/v1/voice/voicemail-handler?accountId=a1&from=%2B1')
      .type('form')
      .send({ DialCallStatus: 'no-answer' });
    expect(res.text).toContain('<Response/>');
    expect(res.text).not.toContain('<Record');
  });
});

describe('POST /v1/voice/voicemail-complete', () => {
  beforeEach(() => {
    accountService.getAccountById.mockReset();
    voicemailService.createVoicemail.mockReset();
    voicemailService.setRecording.mockReset();
    pushService.sendMessagePush.mockReset();
    emailClient.sendEmail.mockReset();
    s3.bucket.mockReset();
    s3.archiveRecording.mockReset();
    s3.objectUrl.mockReset();
    // Default: S3 archival disabled (no bucket) so base tests don't touch S3.
    s3.bucket.mockReturnValue('');
  });

  it('archives the recording to S3 and stores the key when a bucket is set', async () => {
    s3.bucket.mockReturnValue('mobilitynet-recordings');
    s3.archiveRecording.mockResolvedValueOnce({ key: 'voicemails/a1/vm-1.wav' });
    s3.objectUrl.mockReturnValue('https://s3/voicemails/a1/vm-1.wav');
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', tenant_id: 'ten-1' });
    voicemailService.createVoicemail.mockResolvedValueOnce({ id: 'vm-1' });
    voicemailService.setRecording.mockResolvedValueOnce({ id: 'vm-1' });

    const res = await request(app)
      .post('/v1/voice/voicemail-complete?accountId=a1&from=%2B1')
      .type('form')
      .send({ RecordingUrl: 'https://telnyx/rec', RecordingDuration: '8' });

    expect(res.status).toBe(200);
    expect(s3.archiveRecording).toHaveBeenCalledWith({
      key: 'voicemails/a1/vm-1.wav', sourceUrl: 'https://telnyx/rec',
    });
    expect(voicemailService.setRecording).toHaveBeenCalledWith('vm-1', {
      s3Key: 'voicemails/a1/vm-1.wav',
      recordingUrl: 'https://s3/voicemails/a1/vm-1.wav',
    });
  });

  it('keeps the Telnyx URL (no setRecording) when S3 archival fails', async () => {
    s3.bucket.mockReturnValue('mobilitynet-recordings');
    s3.archiveRecording.mockRejectedValueOnce(new Error('s3 down'));
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', tenant_id: 'ten-1' });
    voicemailService.createVoicemail.mockResolvedValueOnce({ id: 'vm-1' });

    const res = await request(app)
      .post('/v1/voice/voicemail-complete?accountId=a1&from=%2B1')
      .type('form')
      .send({ RecordingUrl: 'https://telnyx/rec', RecordingDuration: '8' });

    expect(res.status).toBe(200);
    expect(voicemailService.setRecording).not.toHaveBeenCalled();
  });

  it('stores the voicemail, pushes, emails, and returns an empty Response', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: 'a1', tenant_id: 'ten-1', email: 'jane@example.com',
    });
    voicemailService.createVoicemail.mockResolvedValueOnce({ id: 'vm-1' });
    pushService.sendMessagePush.mockResolvedValueOnce({ sent: 1 });
    emailClient.sendEmail.mockResolvedValueOnce({ sent: true });

    const res = await request(app)
      .post('/v1/voice/voicemail-complete?accountId=a1&from=%2B12022762305')
      .type('form')
      .send({ RecordingUrl: 'https://rec/1.mp3', RecordingDuration: '15', RecordingSid: 'RS1' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
    expect(voicemailService.createVoicemail).toHaveBeenCalledWith({
      accountId: 'a1',
      tenantId: 'ten-1',
      callerNumber: '+12022762305',
      recordingUrl: 'https://rec/1.mp3',
      recordingSid: 'RS1',
      durationSeconds: 15,
    });
    expect(pushService.sendMessagePush).toHaveBeenCalledWith('a1', expect.objectContaining({
      from: '+12022762305', messageId: 'vm-1',
    }));
    expect(emailClient.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'jane@example.com',
      subject: 'New voicemail from +12022762305',
    }));
  });

  it('still returns 200 empty Response when storage throws', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', tenant_id: 'ten-1' });
    voicemailService.createVoicemail.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app)
      .post('/v1/voice/voicemail-complete?accountId=a1&from=%2B1')
      .type('form')
      .send({ RecordingUrl: 'https://rec/2.mp3', RecordingDuration: '3' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
  });
});

describe('POST /v1/voice/voicemail-transcription', () => {
  beforeEach(() => voicemailService.attachTranscription.mockReset());

  it('attaches the transcription and acks 200', async () => {
    voicemailService.attachTranscription.mockResolvedValueOnce({ id: 'vm-1' });
    const res = await request(app)
      .post('/v1/voice/voicemail-transcription?accountId=a1')
      .type('form')
      .send({ TranscriptionText: 'Hi, call me back', RecordingSid: 'RS1' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(voicemailService.attachTranscription).toHaveBeenCalledWith({
      accountId: 'a1', recordingSid: 'RS1', transcription: 'Hi, call me back',
    });
  });

  it('acks 200 even when there is no transcription text', async () => {
    const res = await request(app)
      .post('/v1/voice/voicemail-transcription?accountId=a1')
      .type('form')
      .send({});
    expect(res.status).toBe(200);
    expect(voicemailService.attachTranscription).not.toHaveBeenCalled();
  });
});

describe('inbound → voicemail system DID', () => {
  beforeEach(() => {
    voiceService.lookupByCalledNumber.mockReset();
    accountService.lookupByPhoneE164.mockReset();
  });

  it('routes a call to the system DID into the IVR menu (keyed by caller ID)', async () => {
    accountService.lookupByPhoneE164.mockResolvedValueOnce({ id: 'acc-1' });
    const res = await request(app)
      .post('/v1/voice/inbound')
      .type('form')
      .send({ To: '+15550000086', From: '+12085550142', CallSid: 'CAvm' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather numDigits="1"');
    expect(res.text).toContain('Voicemail menu.');
    expect(res.text).toContain('/v1/voice/voicemail-menu-action?accountId=acc-1');
    expect(accountService.lookupByPhoneE164).toHaveBeenCalledWith('+12085550142');
    // Did NOT try to dial a subscriber.
    expect(voiceService.lookupByCalledNumber).not.toHaveBeenCalled();
    expect(res.text).not.toContain('<Dial');
  });

  it('hangs up when the system-DID caller is not a known subscriber', async () => {
    accountService.lookupByPhoneE164.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/v1/voice/inbound')
      .type('form')
      .send({ To: '+15550000086', From: '+19999999999', CallSid: 'CAvm2' });
    expect(res.text).toContain('We could not find your account.');
    expect(res.text).toContain('<Hangup/>');
  });
});

describe('POST /v1/voice/voicemail-menu', () => {
  beforeEach(() => {
    accountService.lookupByPhoneE164.mockReset();
    accountService.getAccountById.mockReset();
  });

  it('greets a known caller with the main menu', async () => {
    accountService.lookupByPhoneE164.mockResolvedValueOnce({ id: 'acc-1' });
    const res = await request(app)
      .post('/v1/voice/voicemail-menu')
      .type('form')
      .send({ From: '+12085550142' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('Press 1 to listen to your messages.');
    expect(res.text).toContain('/v1/voice/voicemail-menu-action?accountId=acc-1');
  });

  it('hangs up for an unknown caller', async () => {
    accountService.lookupByPhoneE164.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/v1/voice/voicemail-menu')
      .type('form')
      .send({ From: '+19999999999' });
    expect(res.text).toContain('We could not find your account.');
    expect(res.text).toContain('<Hangup/>');
  });

  it('accepts a GET (in-IVR <Redirect> re-fetches via GET)', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'acc-1' });
    const res = await request(app).get('/v1/voice/voicemail-menu?accountId=acc-1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('Voicemail menu.');
  });

  it('resolves by accountId on an in-IVR redirect', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'acc-1' });
    const res = await request(app)
      .post('/v1/voice/voicemail-menu?accountId=acc-1')
      .type('form')
      .send({});
    expect(res.text).toContain('Voicemail menu.');
    expect(accountService.getAccountById).toHaveBeenCalledWith('acc-1');
    expect(accountService.lookupByPhoneE164).not.toHaveBeenCalled();
  });
});

describe('POST /v1/voice/voicemail-menu-action', () => {
  beforeEach(() => {
    voicemailService.getVoicemails.mockReset();
    voicemailService.clearGreeting.mockReset();
  });

  it('accepts a GET (Telnyx calls the Gather action via GET when it was served over GET)', async () => {
    voicemailService.getVoicemails.mockResolvedValueOnce([]);
    const res = await request(app)
      .get('/v1/voice/voicemail-menu-action?accountId=acc-1&Digits=1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('You have no messages.');
  });

  it('digit 1 with no messages redirects to the menu', async () => {
    voicemailService.getVoicemails.mockResolvedValueOnce([]);
    const res = await request(app)
      .post('/v1/voice/voicemail-menu-action?accountId=acc-1')
      .type('form')
      .send({ Digits: '1' });
    expect(res.text).toContain('You have no messages.');
    expect(res.text).toContain('<Redirect>');
    expect(res.text).toContain('/v1/voice/voicemail-menu?accountId=acc-1');
  });

  it('digit 1 plays the newest with a fresh signed URL and per-message actions', async () => {
    voicemailService.getVoicemails.mockResolvedValueOnce([{
      id: 'vm-1',
      caller_number: '+12022762305',
      duration_seconds: 12,
      recording_s3_key: 'mms/acc-1/vm-1.wav',
      created_at: '2026-07-01T00:00:00.000Z',
    }]);
    s3.signedUrlForVoicemail.mockResolvedValueOnce('https://signed.example/rec1');
    const res = await request(app)
      .post('/v1/voice/voicemail-menu-action?accountId=acc-1')
      .type('form')
      .send({ Digits: '1' });
    expect(res.text).toContain('Message from +12022762305');
    expect(res.text).toContain('12 seconds.');
    expect(res.text).toContain('<Play>https://signed.example/rec1</Play>');
    expect(res.text).toContain('/v1/voice/voicemail-message-action?accountId=acc-1&amp;vmId=vm-1');
  });

  it('digit 1 says "Recording unavailable" when no URL can be resolved', async () => {
    voicemailService.getVoicemails.mockResolvedValueOnce([{
      id: 'vm-1', caller_number: '+12022762305', duration_seconds: 5,
    }]);
    s3.signedUrlForVoicemail.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/v1/voice/voicemail-menu-action?accountId=acc-1')
      .type('form')
      .send({ Digits: '1' });
    expect(res.text).toContain('Recording unavailable.');
    expect(res.text).not.toContain('<Play>');
    // Still offers the per-message Gather so the caller can move on.
    expect(res.text).toContain('/v1/voice/voicemail-message-action?accountId=acc-1&amp;vmId=vm-1');
  });

  it('digit 2 prompts to record a greeting', async () => {
    const res = await request(app)
      .post('/v1/voice/voicemail-menu-action?accountId=acc-1')
      .type('form')
      .send({ Digits: '2' });
    expect(res.text).toContain('Record your greeting after the beep.');
    expect(res.text).toContain('<Record maxLength="30"');
    expect(res.text).toContain('/v1/voice/voicemail-greeting-save?accountId=acc-1');
  });

  it('digit 3 clears the greeting and returns to the menu', async () => {
    voicemailService.clearGreeting.mockResolvedValueOnce({ id: 'acc-1' });
    const res = await request(app)
      .post('/v1/voice/voicemail-menu-action?accountId=acc-1')
      .type('form')
      .send({ Digits: '3' });
    expect(voicemailService.clearGreeting).toHaveBeenCalledWith('acc-1');
    expect(res.text).toContain('reset to the default');
    expect(res.text).toContain('<Redirect>');
  });

  it('digit 9 hangs up', async () => {
    const res = await request(app)
      .post('/v1/voice/voicemail-menu-action?accountId=acc-1')
      .type('form')
      .send({ Digits: '9' });
    expect(res.text).toContain('Goodbye.');
    expect(res.text).toContain('<Hangup/>');
  });
});

describe('POST /v1/voice/voicemail-greeting-save', () => {
  beforeEach(() => {
    voicemailService.setGreeting.mockReset();
    s3.bucket.mockReset();
    s3.archiveRecording.mockReset();
  });

  it('archives the greeting to S3 and stores the key', async () => {
    s3.bucket.mockReturnValue('mobilitynet-recordings');
    s3.archiveRecording.mockResolvedValueOnce({ key: 'greetings/acc-1/greeting.wav' });
    voicemailService.setGreeting.mockResolvedValueOnce({ id: 'acc-1' });
    const res = await request(app)
      .post('/v1/voice/voicemail-greeting-save?accountId=acc-1')
      .type('form')
      .send({ RecordingUrl: 'https://telnyx/greet' });
    expect(s3.archiveRecording).toHaveBeenCalledWith({
      key: 'greetings/acc-1/greeting.wav',
      sourceUrl: 'https://telnyx/greet',
      contentType: 'audio/wav',
    });
    expect(voicemailService.setGreeting).toHaveBeenCalledWith('acc-1', {
      url: null, s3Key: 'greetings/acc-1/greeting.wav',
    });
    expect(res.text).toContain('Your greeting has been saved.');
    expect(res.text).toContain('/v1/voice/voicemail-menu?accountId=acc-1');
  });

  it('falls back to the Telnyx URL when S3 archival fails', async () => {
    s3.bucket.mockReturnValue('mobilitynet-recordings');
    s3.archiveRecording.mockRejectedValueOnce(new Error('s3 down'));
    voicemailService.setGreeting.mockResolvedValueOnce({ id: 'acc-1' });
    await request(app)
      .post('/v1/voice/voicemail-greeting-save?accountId=acc-1')
      .type('form')
      .send({ RecordingUrl: 'https://telnyx/greet' });
    expect(voicemailService.setGreeting).toHaveBeenCalledWith('acc-1', {
      url: 'https://telnyx/greet', s3Key: null,
    });
  });
});

describe('POST /v1/voice/voicemail-message-action', () => {
  beforeEach(() => {
    voicemailService.getVoicemails.mockReset();
    voicemailService.deleteVoicemail.mockReset();
  });

  it('digit 3 deletes the message and plays what took its slot', async () => {
    voicemailService.getVoicemails
      .mockResolvedValueOnce([{ id: 'vm-1' }, { id: 'vm-2' }]) // before
      .mockResolvedValueOnce([{ id: 'vm-2', caller_number: '+1', duration_seconds: 5 }]); // after
    voicemailService.deleteVoicemail.mockResolvedValueOnce({ deleted: true, id: 'vm-1' });
    const res = await request(app)
      .post('/v1/voice/voicemail-message-action?accountId=acc-1&vmId=vm-1')
      .type('form')
      .send({ Digits: '3' });
    expect(voicemailService.deleteVoicemail).toHaveBeenCalledWith('vm-1', { accountId: 'acc-1' });
    expect(res.text).toContain('Message deleted.');
    expect(res.text).toContain('&amp;vmId=vm-2');
  });

  it('digit 3 on the last message returns to the menu', async () => {
    voicemailService.getVoicemails
      .mockResolvedValueOnce([{ id: 'vm-1' }]) // before
      .mockResolvedValueOnce([]); // after
    voicemailService.deleteVoicemail.mockResolvedValueOnce({ deleted: true, id: 'vm-1' });
    const res = await request(app)
      .post('/v1/voice/voicemail-message-action?accountId=acc-1&vmId=vm-1')
      .type('form')
      .send({ Digits: '3' });
    expect(res.text).toContain('Message deleted.');
    expect(res.text).toContain('<Redirect>');
  });

  it('digit 4 plays the next message', async () => {
    voicemailService.getVoicemails.mockResolvedValueOnce([
      { id: 'vm-1' },
      { id: 'vm-2', caller_number: '+12022762305', duration_seconds: 9 },
    ]);
    const res = await request(app)
      .post('/v1/voice/voicemail-message-action?accountId=acc-1&vmId=vm-1')
      .type('form')
      .send({ Digits: '4' });
    expect(res.text).toContain('Message from +12022762305');
    expect(res.text).toContain('&amp;vmId=vm-2');
  });

  it('digit 4 past the last message returns to the menu', async () => {
    voicemailService.getVoicemails.mockResolvedValueOnce([{ id: 'vm-1' }]);
    const res = await request(app)
      .post('/v1/voice/voicemail-message-action?accountId=acc-1&vmId=vm-1')
      .type('form')
      .send({ Digits: '4' });
    expect(res.text).toContain('No more messages.');
    expect(res.text).toContain('<Redirect>');
  });

  it('digit 9 returns to the main menu', async () => {
    const res = await request(app)
      .post('/v1/voice/voicemail-message-action?accountId=acc-1&vmId=vm-1')
      .type('form')
      .send({ Digits: '9' });
    expect(res.text).toContain('/v1/voice/voicemail-menu?accountId=acc-1');
    expect(res.text).toContain('<Redirect>');
  });
});
