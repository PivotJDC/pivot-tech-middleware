jest.mock('../../src/services/accountService');
jest.mock('../../src/services/provisioningService');

// authenticate double: authed iff an Authorization header is present.
const mockAuthenticate = jest.fn();
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => mockAuthenticate(req, res, next),
}));

const express = require('express');
const request = require('supertest');
const accountService = require('../../src/services/accountService');
const provisioningService = require('../../src/services/provisioningService');
const provisioningQrRouter = require('../../src/routes/v1/provisioningQr');
const { errorHandler, errors } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/account', provisioningQrRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

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

describe('GET /v1/account/provisioning-qr', () => {
  it('returns the QR + deep link for my account', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'acc-1', sip_username: 'pivottech-abc' });
    provisioningService.buildProvisioningQr.mockResolvedValueOnce({
      qr_url: 'data:image/png;base64,AAA',
      provisioning_url: 'csc:pivottech-abc:pw@Pivot-Tech',
    });

    const res = await request(app).get('/v1/account/provisioning-qr').set('authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.qr_url).toMatch(/^data:image\/png;base64,/);
    expect(res.body.provisioning_url).toMatch(/^csc:/);
    // Scoped to the token subject.
    expect(accountService.getAccountById).toHaveBeenCalledWith('acc-1');
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/v1/account/provisioning-qr');
    expect(res.status).toBe(401);
    expect(provisioningService.buildProvisioningQr).not.toHaveBeenCalled();
  });
});
