jest.mock('../../src/services/tenantService');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const express = require('express');
const request = require('supertest');
const tenantService = require('../../src/services/tenantService');
const tenantsRouter = require('../../src/routes/admin/tenants');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  // Stand in for the parent admin router's adminAuth (super_admin gating is
  // covered separately in adminAuthRoute.test).
  app.use((req, res, next) => { req.admin = { id: 'jim', role: 'super_admin' }; next(); });
  app.use('/admin/tenants', tenantsRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

beforeEach(() => jest.clearAllMocks());

describe('tenant routes', () => {
  it('POST /admin/tenants creates a tenant', async () => {
    tenantService.createTenant.mockResolvedValueOnce({ id: 't1', slug: 'acme' });
    const res = await request(app).post('/admin/tenants').send({ slug: 'acme', name: 'Acme' });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('acme');
    expect(tenantService.createTenant).toHaveBeenCalledWith({ slug: 'acme', name: 'Acme' });
  });

  it('GET /admin/tenants lists tenants', async () => {
    tenantService.listTenants.mockResolvedValueOnce({ tenants: [{ id: 't1' }], pagination: { total: 1 } });
    const res = await request(app).get('/admin/tenants?status=active');
    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
    expect(tenantService.listTenants).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('GET /admin/tenants/:id returns detail (404 when missing)', async () => {
    tenantService.getTenantById.mockResolvedValueOnce({ id: 't1' });
    const ok = await request(app).get('/admin/tenants/t1');
    expect(ok.status).toBe(200);

    tenantService.getTenantById.mockResolvedValueOnce(null);
    const missing = await request(app).get('/admin/tenants/nope');
    expect(missing.status).toBe(404);
  });

  it('PATCH /admin/tenants/:id updates a tenant', async () => {
    tenantService.updateTenant.mockResolvedValueOnce({ id: 't1', name: 'New' });
    const res = await request(app).patch('/admin/tenants/t1').send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(tenantService.updateTenant).toHaveBeenCalledWith('t1', { name: 'New' });
  });

  it('POST /admin/tenants/:id/suspend + /activate', async () => {
    tenantService.suspendTenant.mockResolvedValueOnce({ id: 't1', status: 'suspended' });
    const s = await request(app).post('/admin/tenants/t1/suspend');
    expect(s.status).toBe(200);
    expect(s.body.status).toBe('suspended');

    tenantService.activateTenant.mockResolvedValueOnce({ id: 't1', status: 'active' });
    const a = await request(app).post('/admin/tenants/t1/activate');
    expect(a.status).toBe(200);
    expect(a.body.status).toBe('active');
  });
});
