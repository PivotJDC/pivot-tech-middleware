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
jest.mock('../../src/services/usageService');
jest.mock('../../src/services/tenantService');
jest.mock('../../src/services/voicemailService');
jest.mock('../../src/integrations/s3');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const express = require('express');
const request = require('supertest');
const adminUserService = require('../../src/services/adminUserService');
const accountService = require('../../src/services/accountService');
const usageService = require('../../src/services/usageService');
const tenantService = require('../../src/services/tenantService');
const voicemailService = require('../../src/services/voicemailService');
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
    expect(adminUserService.login).toHaveBeenCalledWith('jim', 'pw', undefined);
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

// POST /admin/bootstrap is mounted in app.js (before the admin router), so it is
// covered against createApp() in app.test.js — not here.

describe('POST /admin/forgot-password (public)', () => {
  it('always returns { sent: true } (no enumeration)', async () => {
    adminUserService.requestPasswordReset.mockResolvedValueOnce(undefined);
    const res = await request(app).post('/admin/forgot-password').send({ email: 'jim@p.io' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(adminUserService.requestPasswordReset).toHaveBeenCalledWith('jim@p.io');
  });

  it('returns 400 when email is missing', async () => {
    const res = await request(app).post('/admin/forgot-password').send({});
    expect(res.status).toBe(400);
    expect(adminUserService.requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe('POST /admin/reset-password (public)', () => {
  it('returns { reset: true } for a valid token', async () => {
    adminUserService.resetPassword.mockResolvedValueOnce(true);
    const res = await request(app)
      .post('/admin/reset-password')
      .send({ token: 'tok-1', new_password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reset: true });
    expect(adminUserService.resetPassword).toHaveBeenCalledWith('tok-1', 'password123');
  });

  it('returns 401 for an invalid/expired token', async () => {
    adminUserService.resetPassword.mockResolvedValueOnce(false);
    const res = await request(app)
      .post('/admin/reset-password')
      .send({ token: 'bad', new_password: 'password123' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when token or new_password is missing', async () => {
    const res = await request(app).post('/admin/reset-password').send({ token: 'tok-1' });
    expect(res.status).toBe(400);
    expect(adminUserService.resetPassword).not.toHaveBeenCalled();
  });
});

describe('GET /admin/whoami (authenticated)', () => {
  it('returns the current admin identity', async () => {
    mockAdmin = { id: 'jim', role: 'super_admin' };
    adminUserService.getByUsername.mockResolvedValueOnce({
      username: 'jim', email: 'jim@p.io', role: 'super_admin',
    });
    const res = await request(app).get('/admin/whoami');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: 'jim', email: 'jim@p.io', role: 'super_admin' });
    expect(adminUserService.getByUsername).toHaveBeenCalledWith('jim');
  });

  it('404s when the token subject no longer exists', async () => {
    adminUserService.getByUsername.mockResolvedValueOnce(null);
    const res = await request(app).get('/admin/whoami');
    expect(res.status).toBe(404);
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

describe('PATCH /admin/users/:id (super_admin only)', () => {
  it('changes a role for a super_admin', async () => {
    adminUserService.updateAdminUserRole.mockResolvedValueOnce({ id: 'u2', role: 'viewer' });
    const res = await request(app).patch('/admin/users/u2').send({ role: 'viewer' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('viewer');
    // Caller identity (JWT sub) is passed for the self-guard.
    expect(adminUserService.updateAdminUserRole).toHaveBeenCalledWith('u2', 'viewer', 'jim');
  });

  it('400s when role is missing', async () => {
    const res = await request(app).patch('/admin/users/u2').send({});
    expect(res.status).toBe(400);
    expect(adminUserService.updateAdminUserRole).not.toHaveBeenCalled();
  });

  it('forbids a non-super_admin', async () => {
    mockAdmin = { id: 'x', role: 'admin' };
    const res = await request(app).patch('/admin/users/u2').send({ role: 'viewer' });
    expect(res.status).toBe(403);
    expect(adminUserService.updateAdminUserRole).not.toHaveBeenCalled();
  });
});

describe('DELETE /admin/users/:id (super_admin only)', () => {
  it('deletes for a super_admin', async () => {
    adminUserService.deleteAdminUser.mockResolvedValueOnce({ deleted: true, id: 'u2' });
    const res = await request(app).delete('/admin/users/u2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 'u2' });
    expect(adminUserService.deleteAdminUser).toHaveBeenCalledWith('u2', 'jim');
  });

  it('forbids a viewer', async () => {
    mockAdmin = { id: 'v', role: 'viewer' };
    const res = await request(app).delete('/admin/users/u2');
    expect(res.status).toBe(403);
    expect(adminUserService.deleteAdminUser).not.toHaveBeenCalled();
  });
});

describe('/admin/tenants (super_admin only)', () => {
  it('lists tenants for a super_admin', async () => {
    tenantService.listTenants.mockResolvedValueOnce({ tenants: [{ id: 't1' }], pagination: {} });
    const res = await request(app).get('/admin/tenants');
    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
  });

  it('creates a tenant for a super_admin', async () => {
    tenantService.createTenant.mockResolvedValueOnce({ id: 't1', slug: 'acme' });
    const res = await request(app).post('/admin/tenants').send({ slug: 'acme', name: 'Acme' });
    expect(res.status).toBe(201);
  });

  it('forbids a non-super_admin from any tenant route', async () => {
    mockAdmin = { id: 'x', role: 'admin' };
    const list = await request(app).get('/admin/tenants');
    expect(list.status).toBe(403);
    const create = await request(app).post('/admin/tenants').send({ slug: 'a', name: 'A' });
    expect(create.status).toBe(403);
    expect(tenantService.listTenants).not.toHaveBeenCalled();
    expect(tenantService.createTenant).not.toHaveBeenCalled();
  });
});

describe('POST /admin/usage/poll (super_admin only)', () => {
  it('runs a poll for a super_admin', async () => {
    usageService.pollAllActiveAccounts.mockResolvedValueOnce({
      polled: 2, succeeded: 2, failed: 0,
    });
    const res = await request(app).post('/admin/usage/poll');
    expect(res.status).toBe(200);
    expect(res.body.polled).toBe(2);
  });

  it('forbids a non-super_admin', async () => {
    mockAdmin = { id: 'x', role: 'admin' };
    const res = await request(app).post('/admin/usage/poll');
    expect(res.status).toBe(403);
    expect(usageService.pollAllActiveAccounts).not.toHaveBeenCalled();
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

describe('POST /admin/accounts/:id/refresh-sip-credentials (super_admin only)', () => {
  it('refreshes for a super_admin', async () => {
    accountService.refreshSipPasswordHash.mockResolvedValueOnce({ updated: true });
    const res = await request(app).post('/admin/accounts/a1/refresh-sip-credentials').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: true });
    expect(accountService.refreshSipPasswordHash).toHaveBeenCalledWith('a1');
  });

  it('forbids a non-super_admin', async () => {
    mockAdmin = { id: 'x', role: 'admin' };
    const res = await request(app).post('/admin/accounts/a1/refresh-sip-credentials').send({});
    expect(res.status).toBe(403);
    expect(accountService.refreshSipPasswordHash).not.toHaveBeenCalled();
  });
});

describe('POST /admin/accounts/:id/esim-qr (super_admin + admin)', () => {
  it('allows an admin', async () => {
    mockAdmin = { id: 'a', role: 'admin' };
    accountService.getEsimQr.mockResolvedValueOnce({ qr_code_url: 'data:image/png;base64,AAA' });
    const res = await request(app).post('/admin/accounts/a1/esim-qr').send({});
    expect(res.status).toBe(200);
    expect(accountService.getEsimQr).toHaveBeenCalledWith('a1', { regenerate: false });
  });

  it('allows a super_admin', async () => {
    mockAdmin = { id: 'jim', role: 'super_admin' };
    accountService.getEsimQr.mockResolvedValueOnce({ qr_code_url: 'data:image/png;base64,AAA' });
    const res = await request(app).post('/admin/accounts/a1/esim-qr').send({ regenerate: true });
    expect(res.status).toBe(200);
    expect(accountService.getEsimQr).toHaveBeenCalledWith('a1', { regenerate: true });
  });

  it('forbids a viewer', async () => {
    mockAdmin = { id: 'v', role: 'viewer' };
    const res = await request(app).post('/admin/accounts/a1/esim-qr').send({});
    expect(res.status).toBe(403);
    expect(accountService.getEsimQr).not.toHaveBeenCalled();
  });
});

describe('voicemail admin routes (super_admin + admin)', () => {
  it('allows an admin to list account voicemails', async () => {
    mockAdmin = { id: 'a', role: 'admin' };
    voicemailService.getVoicemails.mockResolvedValueOnce([]);
    const res = await request(app).get('/admin/accounts/a1/voicemails');
    expect(res.status).toBe(200);
    expect(voicemailService.getVoicemails).toHaveBeenCalled();
  });

  it('forbids a viewer from listing voicemails', async () => {
    mockAdmin = { id: 'v', role: 'viewer' };
    const res = await request(app).get('/admin/accounts/a1/voicemails');
    expect(res.status).toBe(403);
    expect(voicemailService.getVoicemails).not.toHaveBeenCalled();
  });

  it('forbids a viewer from deleting a voicemail', async () => {
    mockAdmin = { id: 'v', role: 'viewer' };
    const res = await request(app).delete('/admin/voicemails/vm-1');
    expect(res.status).toBe(403);
    expect(voicemailService.deleteVoicemail).not.toHaveBeenCalled();
  });

  it('forbids a viewer from the recording endpoint', async () => {
    mockAdmin = { id: 'v', role: 'viewer' };
    const res = await request(app).get('/admin/voicemails/vm-1/recording?format=json');
    expect(res.status).toBe(403);
    expect(voicemailService.getById).not.toHaveBeenCalled();
  });
});
