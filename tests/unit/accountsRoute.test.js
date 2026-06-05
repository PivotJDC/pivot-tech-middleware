jest.mock('../../src/services/accountService');
jest.mock('../../src/services/provisioningService');

const express = require('express');
const request = require('supertest');
const accountService = require('../../src/services/accountService');
const provisioningService = require('../../src/services/provisioningService');
const accountsRouter = require('../../src/routes/v1/accounts');
const { errorHandler, errors } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/accounts', accountsRouter);
  app.use(errorHandler);
  return app;
}

describe('POST /v1/accounts', () => {
  const app = buildApp();
  beforeEach(() => jest.clearAllMocks());

  it('returns the account plus provisioning links, without the raw token', async () => {
    accountService.createAccount.mockResolvedValueOnce({
      id: 'acc-1', email: 'a@b.co', status: 'pending', phone_e164: '+12085550100',
    });
    provisioningService.issueToken.mockResolvedValueOnce({
      raw_token: 'secret-token',
      expires_at: '2026-06-08T00:00:00Z',
      provisioning_url: 'https://api.pivot-tech.io/v1/provision?token=secret-token',
      qr_code_url: 'data:image/png;base64,AAAA',
      deep_link: 'https://api.pivot-tech.io/v1/provision?token=secret-token',
    });

    const res = await request(app)
      .post('/v1/accounts')
      .send({ email: 'a@b.co', market: 'lewiston-id' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('acc-1');
    expect(res.body.provisioning.provisioning_url).toContain('token=secret-token');
    expect(res.body.provisioning.qr_code_url).toMatch(/^data:image\/png;base64,/);
    expect(res.body.provisioning.deep_link).toContain('token=secret-token');
    expect(res.body.provisioning.expires_at).toBeDefined();
    // raw token must NOT be exposed in the response
    expect(res.body.provisioning.raw_token).toBeUndefined();
  });

  it('surfaces a validation error from the service', async () => {
    accountService.createAccount.mockRejectedValueOnce(errors.validation('bad email', 'email'));
    const res = await request(app).post('/v1/accounts').send({ email: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(provisioningService.issueToken).not.toHaveBeenCalled();
  });
});
