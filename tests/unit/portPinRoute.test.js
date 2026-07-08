jest.mock('../../src/services/accountService');

// authenticate double: authed iff an Authorization header is present.
const mockAuthenticate = jest.fn();
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => mockAuthenticate(req, res, next),
}));

const express = require('express');
const request = require('supertest');
const accountService = require('../../src/services/accountService');
const portPinRouter = require('../../src/routes/v1/portPin');
const { errorHandler, errors } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/account', portPinRouter);
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

describe('GET /v1/account/port-pin', () => {
  it('returns my port-out PIN', async () => {
    accountService.getPortPin.mockResolvedValueOnce({ port_out_pin: '482913' });
    const res = await request(app).get('/v1/account/port-pin').set('authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ port_out_pin: '482913' });
    // Scoped to the token subject — no account id from the client.
    expect(accountService.getPortPin).toHaveBeenCalledWith('acc-1');
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/v1/account/port-pin');
    expect(res.status).toBe(401);
    expect(accountService.getPortPin).not.toHaveBeenCalled();
  });
});

describe('POST /v1/account/port-pin/reset', () => {
  it('resets and returns a fresh PIN for my account', async () => {
    accountService.resetPortPin.mockResolvedValueOnce({ port_out_pin: '100200' });
    const res = await request(app).post('/v1/account/port-pin/reset').set('authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ port_out_pin: '100200' });
    expect(accountService.resetPortPin).toHaveBeenCalledWith('acc-1');
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/v1/account/port-pin/reset');
    expect(res.status).toBe(401);
    expect(accountService.resetPortPin).not.toHaveBeenCalled();
  });
});
