// Controls the identity adminAuth injects per test (name starts with `mock`
// so jest allows it inside the hoisted factory).
let mockAdmin = { id: 'jim', role: 'super_admin' };

// Stub adminAuth to inject mockAdmin, but keep the REAL requireRole so role
// authorization is genuinely exercised.
jest.mock('../../src/middleware/adminAuth', () => {
  const actual = jest.requireActual('../../src/middleware/adminAuth');
  return {
    ...actual,
    adminAuth: (req, res, next) => { req.admin = mockAdmin; next(); },
  };
});
// Pass-through rate limiter (the limiter itself is covered in rateLimiter.test).
jest.mock('../../src/middleware/rateLimiter', () => ({
  rateLimit: () => (req, res, next) => next(),
}));
jest.mock('../../src/services/adminUserService');
jest.mock('../../src/services/adminService');
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/provisioningService');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const express = require('express');
const request = require('supertest');
const adminUserService = require('../../src/services/adminUserService');
const adminRouter = require('../../src/routes/admin');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

beforeEach(() => {
  jest.clearAllMocks();
  mockAdmin = { id: 'jim', role: 'super_admin' };
});

describe('POST /admin/login', () => {
  it('returns a token on valid credentials', async () => {
    adminUserService.login.mockResolvedValueOnce({ token: 'tok', username: 'jim', role: 'super_admin' });
    const res = await request(app).post('/admin/login').send({ username: 'jim', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: 'tok', username: 'jim', role: 'super_admin' });
    expect(adminUserService.login).toHaveBeenCalledWith('jim', 'pw');
  });

  it('returns 401 on invalid credentials', async () => {
    adminUserService.login.mockResolvedValueOnce(null);
    const res = await request(app).post('/admin/login').send({ username: 'jim', password: 'bad' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 when username or password is missing', async () => {
    const res = await request(app).post('/admin/login').send({ username: 'jim' });
    expect(res.status).toBe(400);
    expect(adminUserService.login).not.toHaveBeenCalled();
  });
});

describe('POST /admin/bootstrap (public, one-time)', () => {
  it('creates the first super_admin when no admin users exist', async () => {
    adminUserService.countAdminUsers.mockResolvedValueOnce(0);
    adminUserService.createAdminUser.mockResolvedValueOnce({
      id: 'u1', username: 'jim', email: 'jim@p.io', role: 'super_admin',
    });

    const res = await request(app)
      .post('/admin/bootstrap')
      .send({ username: 'jim', email: 'jim@p.io', password: 'password1' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('super_admin');
    // role is forced to super_admin regardless of any supplied value.
    expect(adminUserService.createAdminUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'jim', role: 'super_admin' }),
    );
  });

  it('forces super_admin even if a different role is supplied', async () => {
    adminUserService.countAdminUsers.mockResolvedValueOnce(0);
    adminUserService.createAdminUser.mockResolvedValueOnce({ id: 'u1', role: 'super_admin' });

    await request(app)
      .post('/admin/bootstrap')
      .send({
        username: 'jim', email: 'jim@p.io', password: 'password1', role: 'viewer',
      });

    expect(adminUserService.createAdminUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'super_admin' }),
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

describe('POST /admin/users (super_admin only)', () => {
  it('creates a user when caller is super_admin', async () => {
    adminUserService.createAdminUser.mockResolvedValueOnce({
      id: 'u2', username: 'ops', email: 'ops@p.io', role: 'admin',
    });
    const res = await request(app)
      .post('/admin/users')
      .send({
        username: 'ops', email: 'ops@p.io', password: 'password1', role: 'admin',
      });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('ops');
    expect(res.body).not.toHaveProperty('password_hash');
  });

  it('forbids a non-super_admin (admin role) from creating users', async () => {
    mockAdmin = { id: 'someone', role: 'admin' };
    const res = await request(app)
      .post('/admin/users')
      .send({ username: 'x', email: 'x@p.io', password: 'password1' });
    expect(res.status).toBe(403);
    expect(adminUserService.createAdminUser).not.toHaveBeenCalled();
  });

  it('forbids a token with no role at all', async () => {
    mockAdmin = { id: 'legacy' };
    const res = await request(app)
      .post('/admin/users')
      .send({ username: 'x', email: 'x@p.io', password: 'password1' });
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/users (super_admin only)', () => {
  it('lists users for a super_admin', async () => {
    adminUserService.listAdminUsers.mockResolvedValueOnce([
      { id: 'u1', username: 'jim', role: 'super_admin' },
    ]);
    const res = await request(app).get('/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
  });

  it('forbids a viewer', async () => {
    mockAdmin = { id: 'v', role: 'viewer' };
    const res = await request(app).get('/admin/users');
    expect(res.status).toBe(403);
    expect(adminUserService.listAdminUsers).not.toHaveBeenCalled();
  });
});
