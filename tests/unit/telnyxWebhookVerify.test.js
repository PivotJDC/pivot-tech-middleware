jest.mock('../../src/integrations/telnyx');
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {},
  },
  REDACT_PATHS: [],
}));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const telnyx = require('../../src/integrations/telnyx');
const { verifyTelnyxWebhook } = require('../../src/middleware/telnyxWebhookVerify');
const { errorHandler } = require('../../src/middleware/errorHandler');

// A real Ed25519 keypair: export the public key as the base64 raw 32 bytes that
// Telnyx publishes, and sign payloads with the private key like Telnyx does.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const base64PublicKey = publicKey.export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('base64');

/** Sign `${timestamp}|${body}` the way Telnyx does, returning the base64 sig. */
function sign(timestamp, body) {
  const message = Buffer.from(`${timestamp}|${body}`, 'utf8');
  return crypto.sign(null, message, privateKey).toString('base64');
}

function buildApp() {
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.post('/hook', verifyTelnyxWebhook, (req, res) => res.status(200).json({ ok: true }));
  app.use(errorHandler);
  return app;
}

const app = buildApp();

beforeEach(() => {
  jest.clearAllMocks();
});

describe('verifyTelnyxWebhook', () => {
  it('passes a request with a valid Ed25519 signature', async () => {
    telnyx.getWebhookPublicKey.mockResolvedValue(base64PublicKey);
    const body = { data: { event_type: 'message.received' } };
    const raw = JSON.stringify(body);
    const ts = '1700000000';

    const res = await request(app)
      .post('/hook')
      .set('telnyx-timestamp', ts)
      .set('telnyx-signature-ed25519', sign(ts, raw))
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects a request whose signature does not match the body (403)', async () => {
    telnyx.getWebhookPublicKey.mockResolvedValue(base64PublicKey);
    const ts = '1700000000';
    // Signature is over a different body than what we send.
    const signature = sign(ts, JSON.stringify({ data: { event_type: 'other' } }));

    const res = await request(app)
      .post('/hook')
      .set('telnyx-timestamp', ts)
      .set('telnyx-signature-ed25519', signature)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ data: { event_type: 'message.received' } }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects when the signature headers are missing (403)', async () => {
    telnyx.getWebhookPublicKey.mockResolvedValue(base64PublicKey);
    const res = await request(app)
      .post('/hook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ data: {} }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('skips verification (and passes) when no public key is configured', async () => {
    telnyx.getWebhookPublicKey.mockResolvedValue('');
    const res = await request(app)
      .post('/hook')
      // No signature headers at all — would 403 if a key were configured.
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ data: { event_type: 'message.received' } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('skips verification when the public key lookup throws', async () => {
    telnyx.getWebhookPublicKey.mockRejectedValue(new Error('network'));
    const res = await request(app)
      .post('/hook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ data: {} }));

    expect(res.status).toBe(200);
  });
});
