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

const express = require('express');
const request = require('supertest');
const accountService = require('../../src/services/accountService');
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
