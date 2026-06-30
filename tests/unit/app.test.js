jest.mock('../../src/db');
jest.mock('../../src/services/adminUserService');

const request = require('supertest');
const db = require('../../src/db');
const adminUserService = require('../../src/services/adminUserService');
const { createApp } = require('../../src/app');
const { errors } = require('../../src/middleware/errorHandler');

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

describe('POST /admin/bootstrap (mounted before the admin router)', () => {
  const app = createApp();
  beforeEach(() => jest.clearAllMocks());

  it('creates the first super_admin when none exist — no auth required', async () => {
    adminUserService.countAdminUsers.mockResolvedValueOnce(0);
    adminUserService.createAdminUser.mockResolvedValueOnce({
      id: 'u1', username: 'jim', email: 'jim@p.io', role: 'super_admin',
    });

    const res = await request(app)
      .post('/admin/bootstrap')
      .send({ username: 'jim', email: 'jim@p.io', password: 'password1' });

    // The key regression: this is NOT 401, even with no Authorization header.
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('super_admin');
    // role is forced to super_admin regardless of any supplied value.
    expect(adminUserService.createAdminUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'jim', role: 'super_admin' }),
    );
  });

  it('returns 403 once an admin user already exists', async () => {
    adminUserService.countAdminUsers.mockResolvedValueOnce(1);

    const res = await request(app)
      .post('/admin/bootstrap')
      .send({ username: 'x', email: 'x@p.io', password: 'password1' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/already completed/i);
    expect(adminUserService.createAdminUser).not.toHaveBeenCalled();
  });
});

describe('POST /admin/reset-bootstrap (mounted before the admin router)', () => {
  const app = createApp();
  beforeEach(() => jest.clearAllMocks());

  it('truncates admin_users within the window — no auth required', async () => {
    adminUserService.resetBootstrap.mockResolvedValueOnce(undefined);
    const res = await request(app).post('/admin/reset-bootstrap').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reset: true });
    expect(adminUserService.resetBootstrap).toHaveBeenCalled();
  });

  it('propagates a 403 once the reset window has expired', async () => {
    adminUserService.resetBootstrap.mockRejectedValueOnce(
      errors.forbidden('Bootstrap reset window (24h) has expired.'),
    );
    const res = await request(app).post('/admin/reset-bootstrap').send({});
    expect(res.status).toBe(403);
  });
});
