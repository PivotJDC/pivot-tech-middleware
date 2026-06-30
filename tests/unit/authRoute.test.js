// RS256 keypair via mocked config so token sign/verify works end-to-end.
jest.mock('../../src/config', () => {
  // eslint-disable-next-line global-require
  const { generateKeyPairSync } = require('crypto');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { jwt: { signingKey: privateKey, publicKey, customerTtl: '24h' } };
});
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/authService');

const express = require('express');
const request = require('supertest');
const accountService = require('../../src/services/accountService');
const authService = require('../../src/services/authService');
const token = require('../../src/utils/token');
const authRouter = require('../../src/routes/v1/auth');
const { errorHandler, errors } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/auth', authRouter);
  app.use(errorHandler);
  return app;
}

describe('POST /v1/auth/token', () => {
  const app = buildApp();

  beforeEach(() => jest.clearAllMocks());

  it('issues a verifiable RS256 token for a known account', async () => {
    accountService.getAccountByEmail.mockResolvedValueOnce({ id: 'acc-9' });

    const res = await request(app).post('/v1/auth/token').send({ email: 'jane@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.account_id).toBe('acc-9');
    expect(res.body.token_type).toBe('Bearer');
    const claims = token.verifyCustomerToken(res.body.token);
    expect(claims.sub).toBe('acc-9');
  });

  it('returns 400 when email is missing', async () => {
    const res = await request(app).post('/v1/auth/token').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unknown email', async () => {
    accountService.getAccountByEmail.mockRejectedValueOnce(errors.notFound('No account.'));
    const res = await request(app).post('/v1/auth/token').send({ email: 'nope@example.com' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /v1/auth/send-code', () => {
  const app = buildApp();
  beforeEach(() => jest.clearAllMocks());

  it('returns { sent: true } for any email (no enumeration)', async () => {
    authService.sendCode.mockResolvedValueOnce(undefined);
    const res = await request(app).post('/v1/auth/send-code').send({ email: 'jane@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(authService.sendCode).toHaveBeenCalledWith('jane@example.com');
  });

  it('returns 400 when email is missing', async () => {
    const res = await request(app).post('/v1/auth/send-code').send({});
    expect(res.status).toBe(400);
    expect(authService.sendCode).not.toHaveBeenCalled();
  });
});

describe('POST /v1/auth/verify-code', () => {
  const app = buildApp();
  beforeEach(() => jest.clearAllMocks());

  it('returns the token + account on a valid code', async () => {
    authService.verifyCode.mockResolvedValueOnce({
      token: 'signed.jwt',
      account: { id: 'acc-9', email: 'jane@example.com' },
    });
    const res = await request(app)
      .post('/v1/auth/verify-code')
      .send({ email: 'jane@example.com', code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('signed.jwt');
    expect(res.body.account.id).toBe('acc-9');
  });

  it('returns 401 on an invalid/expired code', async () => {
    authService.verifyCode.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/v1/auth/verify-code')
      .send({ email: 'jane@example.com', code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 when email or code is missing', async () => {
    const res = await request(app).post('/v1/auth/verify-code').send({ email: 'jane@example.com' });
    expect(res.status).toBe(400);
    expect(authService.verifyCode).not.toHaveBeenCalled();
  });
});
