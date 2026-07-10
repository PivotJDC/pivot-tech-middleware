jest.mock('../../src/services/portService');
// Bypass the rate limiter (exercised in rateLimiter.test.js).
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
const portService = require('../../src/services/portService');
const portRouter = require('../../src/routes/v1/port');
const { errorHandler, errors } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/port', portRouter);
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

describe('POST /v1/port/check', () => {
  it('is public and returns the portability result', async () => {
    portService.checkPortability.mockResolvedValueOnce({
      portable: true, fast_portable: true, carrier_name: 'AT&T', not_portable_reason: null,
    });
    const res = await request(app).post('/v1/port/check').send({ phone_number: '+12085550142' });
    expect(res.status).toBe(200);
    expect(res.body.portable).toBe(true);
    expect(portService.checkPortability).toHaveBeenCalledWith('+12085550142');
  });
});

describe('POST /v1/port/create', () => {
  it('creates a port for the token subject and returns 201', async () => {
    portService.createPort.mockResolvedValueOnce({ id: 'po-1', status: 'draft' });
    const res = await request(app)
      .post('/v1/port/create')
      .set('authorization', 'Bearer t')
      .send({
        phone_number: '+12085550142',
        account_number: 'ACC-9',
        pin: '4321',
        auth_name: 'Jane Doe',
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'po-1', status: 'draft' });
    expect(portService.createPort).toHaveBeenCalledWith('acc-1', {
      phoneNumber: '+12085550142',
      accountNumber: 'ACC-9',
      pin: '4321',
      authName: 'Jane Doe',
      serviceAddress: undefined,
    });
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/v1/port/create').send({ phone_number: '+1' });
    expect(res.status).toBe(401);
    expect(portService.createPort).not.toHaveBeenCalled();
  });
});

describe('GET /v1/port/status', () => {
  it('returns my current port order', async () => {
    portService.getPortStatus.mockResolvedValueOnce({ id: 'po-1', status: 'submitted' });
    const res = await request(app).get('/v1/port/status').set('authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(portService.getPortStatus).toHaveBeenCalledWith('acc-1');
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/v1/port/status');
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/port/cancel', () => {
  it('cancels my in-progress port', async () => {
    portService.cancelPort.mockResolvedValueOnce({ id: 'po-1', status: 'cancelled' });
    const res = await request(app).post('/v1/port/cancel').set('authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(portService.cancelPort).toHaveBeenCalledWith('acc-1');
  });
});
