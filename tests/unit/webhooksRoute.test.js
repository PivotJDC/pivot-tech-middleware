jest.mock('../../src/services/webhookService');

const express = require('express');
const request = require('supertest');
const webhookService = require('../../src/services/webhookService');
const webhooksRouter = require('../../src/routes/v1/webhooks');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/v1/webhooks', webhooksRouter);
  app.use(errorHandler);
  return app;
}

describe('webhook routes', () => {
  const app = buildApp();
  beforeEach(() => jest.clearAllMocks());

  it('rejects an invalid signature with 403 and does not process', async () => {
    webhookService.verifySignature.mockReturnValue(false);
    const res = await request(app)
      .post('/v1/webhooks/port')
      .set('x-signalwire-signature', 'bad')
      .send({ type: 'port.submitted', data: { port_id: 'swp1' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(webhookService.handlePortEvent).not.toHaveBeenCalled();
  });

  it('processes a port event with a valid signature', async () => {
    webhookService.verifySignature.mockReturnValue(true);
    webhookService.handlePortEvent.mockResolvedValueOnce({ handled: true, status: 'submitted' });
    const res = await request(app)
      .post('/v1/webhooks/port')
      .set('x-signalwire-signature', 'good')
      .send({ type: 'port.submitted', data: { port_id: 'swp1' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, handled: true, status: 'submitted' });
  });

  it('processes a general signalwire event', async () => {
    webhookService.verifySignature.mockReturnValue(true);
    webhookService.handleSignalwireEvent.mockResolvedValueOnce({ handled: true });
    const res = await request(app)
      .post('/v1/webhooks/signalwire')
      .set('x-signalwire-signature', 'good')
      .send({ type: 'call.ended' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});
