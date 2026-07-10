jest.mock('../../src/services/webhookService');
jest.mock('../../src/services/portService');
// Automock the Telnyx integration so the Ed25519 webhook verifier reads no
// public key (getWebhookPublicKey -> undefined) and skips — no network call.
jest.mock('../../src/integrations/telnyx');

const express = require('express');
const request = require('supertest');
const webhookService = require('../../src/services/webhookService');
const portService = require('../../src/services/portService');
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
      .set('x-telnyx-signature', 'bad')
      .send({ type: 'port.submitted', data: { port_id: 'p1' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(webhookService.handlePortEvent).not.toHaveBeenCalled();
  });

  it('processes a port event with a valid signature', async () => {
    webhookService.verifySignature.mockReturnValue(true);
    webhookService.handlePortEvent.mockResolvedValueOnce({ handled: true, status: 'submitted' });
    const res = await request(app)
      .post('/v1/webhooks/port')
      .set('x-telnyx-signature', 'good')
      .send({ type: 'port.submitted', data: { port_id: 'p1' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, handled: true, status: 'submitted' });
  });

  it('processes a FastPort porting event on the /porting route (Ed25519, no key -> skip)', async () => {
    portService.handlePortingWebhook.mockResolvedValueOnce({ handled: true, status: 'ported' });
    const res = await request(app)
      .post('/v1/webhooks/porting')
      .send({ data: { payload: { id: 'tpo-1', status: 'ported' } } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, handled: true, status: 'ported' });
    expect(portService.handlePortingWebhook).toHaveBeenCalled();
  });

  it('acks 200 even when porting processing throws (no Telnyx retry storm)', async () => {
    portService.handlePortingWebhook.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app)
      .post('/v1/webhooks/porting')
      .send({ data: { payload: { id: 'tpo-1', status: 'ported' } } });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it('processes a general event on the /telnyx route', async () => {
    webhookService.verifySignature.mockReturnValue(true);
    webhookService.handleGeneralEvent.mockResolvedValueOnce({ handled: true });
    const res = await request(app)
      .post('/v1/webhooks/telnyx')
      .set('x-telnyx-signature', 'good')
      .send({ type: 'message.finalized' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});
