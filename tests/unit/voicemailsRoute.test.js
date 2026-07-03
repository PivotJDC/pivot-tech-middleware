jest.mock('../../src/services/voicemailService');

// authenticate double: authed iff an Authorization header is present.
const mockAuthenticate = jest.fn();
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => mockAuthenticate(req, res, next),
}));

const express = require('express');
const request = require('supertest');
const voicemailService = require('../../src/services/voicemailService');
const voicemailsRouter = require('../../src/routes/v1/voicemails');
const { errorHandler, errors } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/account', voicemailsRouter);
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

describe('GET /v1/account/voicemails', () => {
  it('lists my voicemails + unread count', async () => {
    voicemailService.getVoicemails.mockResolvedValueOnce([{ id: 'vm-1' }]);
    voicemailService.getVoicemailCount.mockResolvedValueOnce(2);
    const res = await request(app).get('/v1/account/voicemails?limit=10').set('authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.voicemails).toEqual([{ id: 'vm-1' }]);
    expect(res.body.unread).toBe(2);
    expect(voicemailService.getVoicemails).toHaveBeenCalledWith('acc-1', { limit: '10', offset: undefined });
  });

  it('401s without a token', async () => {
    const res = await request(app).get('/v1/account/voicemails');
    expect(res.status).toBe(401);
    expect(voicemailService.getVoicemails).not.toHaveBeenCalled();
  });
});

describe('PATCH /v1/account/voicemails/:id/read', () => {
  it('marks read, scoped to my account', async () => {
    voicemailService.markAsRead.mockResolvedValueOnce({ id: 'vm-1', is_read: true });
    const res = await request(app)
      .patch('/v1/account/voicemails/vm-1/read')
      .set('authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.is_read).toBe(true);
    expect(voicemailService.markAsRead).toHaveBeenCalledWith('vm-1', { accountId: 'acc-1' });
  });

  it('404s when the voicemail is not found / not mine', async () => {
    voicemailService.markAsRead.mockResolvedValueOnce(null);
    const res = await request(app)
      .patch('/v1/account/voicemails/vm-x/read')
      .set('authorization', 'Bearer t');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/account/voicemails/:id', () => {
  it('deletes, scoped to my account', async () => {
    voicemailService.deleteVoicemail.mockResolvedValueOnce({ deleted: true, id: 'vm-1' });
    const res = await request(app)
      .delete('/v1/account/voicemails/vm-1')
      .set('authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 'vm-1' });
    expect(voicemailService.deleteVoicemail).toHaveBeenCalledWith('vm-1', { accountId: 'acc-1' });
  });

  it('404s when not found', async () => {
    voicemailService.deleteVoicemail.mockResolvedValueOnce(null);
    const res = await request(app)
      .delete('/v1/account/voicemails/vm-x')
      .set('authorization', 'Bearer t');
    expect(res.status).toBe(404);
  });
});
