jest.mock('../../src/services/voiceService');
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {},
  },
  REDACT_PATHS: [],
}));

const express = require('express');
const request = require('supertest');
const voiceService = require('../../src/services/voiceService');
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
    expect(res.text).toContain('<Dial>sip:pivottech-abc@sip.telnyx.com</Dial>');
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

  it('also accepts a JSON body', async () => {
    voiceService.lookupByCalledNumber.mockResolvedValueOnce({
      account_id: 'a1', sip_username: 'pivottech-xyz', status: 'active',
    });
    const res = await request(app)
      .post('/v1/voice/inbound')
      .send({ To: '+12085550100', From: '+12085550142', CallControlId: 'cc-1' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Dial>sip:pivottech-xyz@sip.telnyx.com</Dial>');
  });
});

describe('POST /v1/voice/status', () => {
  it('acknowledges a status callback with 200', async () => {
    const res = await request(app)
      .post('/v1/voice/status')
      .type('form')
      .send({ CallSid: 'CA1', CallStatus: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});
