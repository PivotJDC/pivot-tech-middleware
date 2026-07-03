jest.mock('../../src/services/voiceService');
jest.mock('../../src/services/cdrService');
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/voicemailService');
jest.mock('../../src/services/pushService');
jest.mock('../../src/integrations/email');
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
  it('returns <Dial> to the SIP credential for an active account', async () => {
    voiceService.lookupByCalledNumber.mockResolvedValueOnce({
      account_id: 'a1', sip_username: 'pivottech-abc', status: 'active',
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
    expect(res.text).toContain('<Record maxLength="120"');
    expect(res.text).toContain('/v1/voice/voicemail-complete?accountId=a1&amp;from=');
    expect(res.text).toContain('transcribeCallback=');
    expect(res.text).toContain('Thank you. Goodbye.');
  });

  it('plays a custom greeting when the account has one', async () => {
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
    pushService.sendMessagePush.mockReset();
    emailClient.sendEmail.mockReset();
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
