jest.mock('../../src/services/accountService');
jest.mock('../../src/services/voicemailService');
jest.mock('../../src/utils/crypto');
jest.mock('../../src/utils/token');
jest.mock('../../src/integrations/s3');
// Bypass the rate limiter (covered in rateLimiter.test.js).
jest.mock('../../src/middleware/rateLimiter', () => ({
  rateLimit: () => (req, res, next) => next(),
}));
// authenticate double: authed iff an Authorization header is present.
const mockAuthenticate = jest.fn();
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => mockAuthenticate(req, res, next),
}));

const express = require('express');
const request = require('supertest');
const accountService = require('../../src/services/accountService');
const voicemailService = require('../../src/services/voicemailService');
const crypto = require('../../src/utils/crypto');
const token = require('../../src/utils/token');
const s3 = require('../../src/integrations/s3');
const appRouter = require('../../src/routes/v1/app');
const { errorHandler, errors } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/app', appRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

const ACCOUNT = {
  id: 'acc-1',
  tenant_id: 'ten-1',
  phone_e164: '+12085550100',
  sip_username: 'gencred-x',
  sip_password_hash: 'bcrypt-hash',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthenticate.mockImplementation((req, res, next) => {
    if (req.headers.authorization) {
      req.auth = { accountId: 'acc-1' };
      next();
      return;
    }
    next(errors.unauthorized('Missing token.'));
  });
});

describe('POST /v1/app/auth', () => {
  it('mints a JWT from valid SIP credentials', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(ACCOUNT);
    crypto.verifyPassword.mockResolvedValueOnce(true);
    token.signCustomerToken.mockReturnValueOnce('jwt-abc');

    const res = await request(app)
      .post('/v1/app/auth')
      .send({ username: 'gencred-x', password: 's3cret' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: 'jwt-abc',
      account_id: 'acc-1',
      phone_e164: '+12085550100',
    });
    expect(crypto.verifyPassword).toHaveBeenCalledWith('s3cret', 'bcrypt-hash');
    expect(token.signCustomerToken).toHaveBeenCalledWith({ sub: 'acc-1', tenant_id: 'ten-1' });
  });

  it('falls back to E.164 lookup when the SIP username is the phone number', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(null);
    accountService.lookupByPhoneE164.mockResolvedValueOnce(ACCOUNT);
    crypto.verifyPassword.mockResolvedValueOnce(true);
    token.signCustomerToken.mockReturnValueOnce('jwt-abc');

    const res = await request(app)
      .post('/v1/app/auth')
      .send({ username: '+12085550100', password: 's3cret' });

    expect(res.status).toBe(200);
    expect(accountService.lookupByPhoneE164).toHaveBeenCalledWith('+12085550100');
  });

  it('401s on a wrong password (no token minted)', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(ACCOUNT);
    crypto.verifyPassword.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/v1/app/auth')
      .send({ username: 'gencred-x', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(token.signCustomerToken).not.toHaveBeenCalled();
  });

  it('401s for an unknown account', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(null);
    accountService.lookupByPhoneE164.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/v1/app/auth')
      .send({ username: 'nobody', password: 'x' });
    expect(res.status).toBe(401);
  });

  it('401s when credentials are missing', async () => {
    const res = await request(app).post('/v1/app/auth').send({ username: 'gencred-x' });
    expect(res.status).toBe(401);
    expect(accountService.lookupBySipUsername).not.toHaveBeenCalled();
  });
});

describe('GET /v1/app/voicemails', () => {
  const vmRow = {
    id: 'vm-1',
    caller_number: '+12085550142',
    caller_name: 'Jane',
    duration_seconds: 23,
    transcription: 'Hey, call me back.',
    is_read: false,
    created_at: '2026-07-10T12:00:00Z',
    recording_s3_key: 'voicemails/acc-1/vm-1.wav',
  };

  it('returns voicemails with transcription + signed playback URLs and unread count', async () => {
    voicemailService.getVoicemails.mockResolvedValueOnce([vmRow]);
    voicemailService.getVoicemailCount.mockResolvedValueOnce(1);
    s3.signedUrlForVoicemail.mockResolvedValueOnce('https://signed.example/vm-1.wav');

    const res = await request(app)
      .get('/v1/app/voicemails')
      .set('authorization', 'Bearer jwt-abc');

    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(1);
    expect(res.body.voicemails).toHaveLength(1);
    expect(res.body.voicemails[0]).toEqual({
      id: 'vm-1',
      caller_number: '+12085550142',
      caller_name: 'Jane',
      duration_seconds: 23,
      transcription: 'Hey, call me back.',
      is_read: false,
      created_at: '2026-07-10T12:00:00Z',
      recording_url: 'https://signed.example/vm-1.wav',
    });
    expect(voicemailService.getVoicemails).toHaveBeenCalledWith('acc-1', { limit: undefined, offset: undefined });
  });

  it('tolerates a signing failure (recording_url null) without failing the list', async () => {
    voicemailService.getVoicemails.mockResolvedValueOnce([vmRow]);
    voicemailService.getVoicemailCount.mockResolvedValueOnce(0);
    s3.signedUrlForVoicemail.mockRejectedValueOnce(new Error('s3 down'));

    const res = await request(app)
      .get('/v1/app/voicemails')
      .set('authorization', 'Bearer jwt-abc');

    expect(res.status).toBe(200);
    expect(res.body.voicemails[0].recording_url).toBeNull();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/v1/app/voicemails');
    expect(res.status).toBe(401);
    expect(voicemailService.getVoicemails).not.toHaveBeenCalled();
  });
});
