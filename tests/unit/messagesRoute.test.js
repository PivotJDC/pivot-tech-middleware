jest.mock('../../src/services/messagingService');

// authenticate double: a request is "authed" iff it carries an Authorization
// header (real JWT verification is covered in auth.test.js).
const mockAuthenticate = jest.fn();
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => mockAuthenticate(req, res, next),
}));

const express = require('express');
const request = require('supertest');
const messagingService = require('../../src/services/messagingService');
const messagesRouter = require('../../src/routes/v1/messages');
const { errorHandler, errors } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/messages', messagesRouter);
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
    } else {
      next(errors.unauthorized());
    }
  });
});

describe('POST /v1/messages', () => {
  it('sends a message for the authenticated account', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'm1', direction: 'outbound' });
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer t')
      .send({ to: '+12085550142', body: 'Hello', media_urls: ['https://x/a.jpg'] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('m1');
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142', body: 'Hello', mediaUrls: ['https://x/a.jpg'],
    });
  });

  it('surfaces a service validation error', async () => {
    messagingService.sendMessage.mockRejectedValueOnce(errors.validation('bad to', 'to'));
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer t')
      .send({ body: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('to');
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/v1/messages').send({ to: '+1', body: 'hi' });
    expect(res.status).toBe(401);
    expect(messagingService.sendMessage).not.toHaveBeenCalled();
  });
});

describe('GET /v1/messages', () => {
  it('returns messages for the authenticated account', async () => {
    messagingService.getMessages.mockResolvedValueOnce([{ id: 'm1' }, { id: 'm2' }]);
    const res = await request(app)
      .get('/v1/messages?limit=10&before=2026-06-01T00:00:00Z')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(messagingService.getMessages).toHaveBeenCalledWith('acc-1', {
      limit: '10', before: '2026-06-01T00:00:00Z',
    });
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/v1/messages');
    expect(res.status).toBe(401);
    expect(messagingService.getMessages).not.toHaveBeenCalled();
  });
});

describe('GET /v1/messages/conversation/:number', () => {
  it('returns the conversation thread with a number', async () => {
    messagingService.getConversation.mockResolvedValueOnce([{ id: 'm1' }]);
    const res = await request(app)
      .get(`/v1/messages/conversation/${encodeURIComponent('+12085550142')}`)
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(messagingService.getConversation).toHaveBeenCalledWith('acc-1', '+12085550142', { limit: undefined, before: undefined });
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .get(`/v1/messages/conversation/${encodeURIComponent('+12085550142')}`);
    expect(res.status).toBe(401);
    expect(messagingService.getConversation).not.toHaveBeenCalled();
  });
});
