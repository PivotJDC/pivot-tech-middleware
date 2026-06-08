// Set before requiring config (read + frozen at import time) so the merge with
// CORS_ORIGINS is exercised.
process.env.CORS_ORIGINS = 'https://app.pivot-tech.io';

jest.mock('../../src/db');

const request = require('supertest');
const { createApp } = require('../../src/app');

const app = createApp();
const ACAO = 'access-control-allow-origin';

describe('CORS', () => {
  it.each([
    ['http://localhost:3000', 'local dev'],
    ['http://localhost:3001', 'local dev alt port'],
    ['https://boisterous-twilight-fd4b28.netlify.app', 'Netlify production'],
  ])('allows %s (%s)', async (origin) => {
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

  it('does not allow an arbitrary *.netlify.app site (no wildcard)', async () => {
    const res = await request(app).get('/ping').set('Origin', 'https://some-other-site.netlify.app');
    expect(res.headers[ACAO]).toBeUndefined();
  });

  it('reflects only the configured headers and credentials on preflight', async () => {
    const res = await request(app)
      .options('/v1/accounts')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers[ACAO]).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type,Authorization');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});
