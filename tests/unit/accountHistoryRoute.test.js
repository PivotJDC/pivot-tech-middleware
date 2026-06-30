// Stub the customer auth middleware to a pass-through that sets req.auth to the
// requested :id (so requireSelf, if real, would pass). We only test route
// wiring + the cdr service calls here.
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => { req.auth = { accountId: req.params.id }; next(); },
  requireSelf: (req, res, next) => next(),
}));
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/provisioningService');
jest.mock('../../src/services/cdrService');

const express = require('express');
const request = require('supertest');
const cdrService = require('../../src/services/cdrService');
const accountsRouter = require('../../src/routes/v1/accounts');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/accounts', accountsRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

beforeEach(() => jest.clearAllMocks());

describe('GET /v1/accounts/:id/history', () => {
  it('returns { calls, messages } from the cdr service', async () => {
    cdrService.getCallHistory.mockResolvedValueOnce([{ id: 'cr-1', direction: 'outbound' }]);
    cdrService.getMessageHistory.mockResolvedValueOnce([{ id: 'mr-1', direction: 'inbound' }]);

    const res = await request(app).get('/v1/accounts/acc-1/history?limit=25&offset=5');

    expect(res.status).toBe(200);
    expect(res.body.calls).toHaveLength(1);
    expect(res.body.messages).toHaveLength(1);
    expect(cdrService.getCallHistory).toHaveBeenCalledWith('acc-1', { limit: '25', offset: '5' });
    expect(cdrService.getMessageHistory).toHaveBeenCalledWith('acc-1', { limit: '25', offset: '5' });
  });
});
