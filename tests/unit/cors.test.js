// Set before requiring config (read + frozen at import time) so the merge with
// CORS_ORIGINS is exercised.
process.env.CORS_ORIGINS = 'https://app.pivot-tech.io';

jest.mock('../../src/db');

const request = require('supertest');
const { createApp } = require('../../src/app');

const app = createApp();
const ACAO = 'access-control-allow-origin';

describe('CORS', () => {
  it('allows localhost:3000 (local dev)', async () => {
    const res = await request(app).get('/ping').set('Origin', 'http://localhost:3000');
    expect(res.headers[ACAO]).toBe('http://localhost:3000');
  });

  it('allows the Netlify production origin', async () => {
    const origin = 'https://pivot-tech-dashboard.netlify.app';
    const res = await request(app).get('/ping').set('Origin', origin);
    expect(res.headers[ACAO]).toBe(origin);
  });

  it('allows any *.netlify.app preview subdomain', async () => {
    const origin = 'https://deploy-preview-12--pivot-tech-dashboard.netlify.app';
    const res = await request(app).get('/ping').set('Origin', origin);
    expect(res.headers[ACAO]).toBe(origin);
  });

  it('allows an extra origin supplied via CORS_ORIGINS', async () => {
    const origin = 'https://app.pivot-tech.io';
    const res = await request(app).get('/ping').set('Origin', origin);
    expect(res.headers[ACAO]).toBe(origin);
  });

  it('does not set the CORS header for a disallowed origin', async () => {
    const res = await request(app).get('/ping').set('Origin', 'https://evil.example.com');
    expect(res.headers[ACAO]).toBeUndefined();
    expect(res.status).toBe(200); // request still proceeds; browser blocks the read
  });

  it('does not match a look-alike netlify domain', async () => {
    const res = await request(app).get('/ping').set('Origin', 'https://evil-netlify.app.attacker.com');
    expect(res.headers[ACAO]).toBeUndefined();
  });

  it('answers preflight (OPTIONS) for an allowed origin with the allowed methods', async () => {
    const res = await request(app)
      .options('/v1/accounts')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers[ACAO]).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});
