jest.mock('../../src/db');

const request = require('supertest');
const db = require('../../src/db');
const { createApp } = require('../../src/app');

describe('GET /ping', () => {
  const app = createApp();

  it('returns 200 ok without touching the database', async () => {
    const res = await request(app).get('/ping');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(db.healthCheck).not.toHaveBeenCalled();
  });
});

describe('GET /health', () => {
  const app = createApp();
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 when the database is reachable', async () => {
    db.healthCheck.mockResolvedValueOnce(true);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns 503 when the database is unreachable', async () => {
    db.healthCheck.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', db: 'unreachable' });
  });
});
