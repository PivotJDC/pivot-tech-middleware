// adminAuth is exercised in adminAuth.test.js; here we stub it to a pass-through
// so we can test the route wiring + handlers in isolation.
jest.mock('../../src/middleware/adminAuth', () => ({
  adminAuth: (req, res, next) => { req.admin = { id: 'admin-1' }; next(); },
  verifyAdminToken: jest.fn(),
  isIpAllowed: jest.fn(),
}));
jest.mock('../../src/services/adminService');
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/provisioningService');

const express = require('express');
const request = require('supertest');
const adminService = require('../../src/services/adminService');
const accountService = require('../../src/services/accountService');
const provisioningService = require('../../src/services/provisioningService');
const adminRouter = require('../../src/routes/admin');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

describe('admin API', () => {
  const app = buildApp();
  beforeEach(() => jest.clearAllMocks());

  it('GET /admin/accounts lists accounts', async () => {
    adminService.listAccounts.mockResolvedValueOnce({ accounts: [{ id: 'a1' }], pagination: { total: 1 } });
    const res = await request(app).get('/admin/accounts?status=active&market=lewiston-id');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(adminService.listAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', market: 'lewiston-id' }),
    );
  });

  it('GET /admin/accounts/:id returns detail', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', status: 'active' });
    const res = await request(app).get('/admin/accounts/a1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('a1');
  });

  it('PATCH /admin/accounts/:id/status forces a status change', async () => {
    accountService.transitionStatus.mockResolvedValueOnce({ id: 'a1', status: 'suspended' });
    const res = await request(app)
      .patch('/admin/accounts/a1/status')
      .send({ status: 'suspended', reason: 'fraud review' });
    expect(res.status).toBe(200);
    expect(accountService.transitionStatus).toHaveBeenCalledWith('a1', 'suspended');
    expect(res.body.status).toBe('suspended');
  });

  it('PATCH /admin/accounts/:id/status requires a status', async () => {
    const res = await request(app).patch('/admin/accounts/a1/status').send({});
    expect(res.status).toBe(400);
    expect(accountService.transitionStatus).not.toHaveBeenCalled();
  });

  it('PATCH /admin/accounts/:id with action=retry_bics re-runs eSIM provisioning', async () => {
    accountService.retryBicsProvisioning.mockResolvedValueOnce({
      id: 'a1', bics_provisioned: true, esim: { iccid: 'icc-1', endpointId: 'ep-1' },
    });
    const res = await request(app)
      .patch('/admin/accounts/a1')
      .send({ action: 'retry_bics' });
    expect(res.status).toBe(200);
    expect(accountService.retryBicsProvisioning).toHaveBeenCalledWith('a1');
    expect(res.body.esim.iccid).toBe('icc-1');
  });

  it('PATCH /admin/accounts/:id action=activate transitions a pending account to active', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', status: 'pending' });
    accountService.transitionStatus.mockResolvedValueOnce({ id: 'a1', status: 'active' });
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'activate' });
    expect(res.status).toBe(200);
    expect(accountService.transitionStatus).toHaveBeenCalledWith('a1', 'active');
    expect(res.body.status).toBe('active');
  });

  it('PATCH /admin/accounts/:id action=activate is rejected when not pending', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', status: 'active' });
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'activate' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('action');
    expect(accountService.transitionStatus).not.toHaveBeenCalled();
  });

  it('PATCH /admin/accounts/:id action=suspend transitions to suspended', async () => {
    accountService.transitionStatus.mockResolvedValueOnce({ id: 'a1', status: 'suspended' });
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'suspend' });
    expect(res.status).toBe(200);
    expect(accountService.transitionStatus).toHaveBeenCalledWith('a1', 'suspended');
    // suspend does not pre-fetch the account.
    expect(accountService.getAccountById).not.toHaveBeenCalled();
  });

  it('PATCH /admin/accounts/:id action=cancel transitions to cancelled', async () => {
    accountService.transitionStatus.mockResolvedValueOnce({ id: 'a1', status: 'cancelled' });
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'cancel' });
    expect(res.status).toBe(200);
    expect(accountService.transitionStatus).toHaveBeenCalledWith('a1', 'cancelled');
  });

  it('PATCH /admin/accounts/:id rejects an unsupported action', async () => {
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('action');
    expect(accountService.retryBicsProvisioning).not.toHaveBeenCalled();
  });

  it('POST /admin/accounts/:id/provision/reissue returns a new token', async () => {
    provisioningService.reissueToken.mockResolvedValueOnce({ raw_token: 'rt', provisioning_url: 'u' });
    const res = await request(app).post('/admin/accounts/a1/provision/reissue').send({});
    expect(res.status).toBe(201);
    expect(provisioningService.reissueToken).toHaveBeenCalledWith('a1');
  });

  it('GET /admin/dids lists inventory', async () => {
    adminService.listDids.mockResolvedValueOnce({ dids: [], pagination: {} });
    const res = await request(app).get('/admin/dids?market=lewiston-id&area_code=208');
    expect(res.status).toBe(200);
    expect(adminService.listDids).toHaveBeenCalledWith(
      expect.objectContaining({ market: 'lewiston-id', area_code: '208' }),
    );
  });

  it('GET /admin/ports lists port requests', async () => {
    adminService.listPorts.mockResolvedValueOnce({ ports: [], pagination: {} });
    const res = await request(app).get('/admin/ports?status=failed');
    expect(res.status).toBe(200);
  });

  it('POST /admin/ports/:id/retry resubmits a port', async () => {
    adminService.retryPort.mockResolvedValueOnce({ id: 'p1', status: 'submitted' });
    const res = await request(app).post('/admin/ports/p1/retry').send({});
    expect(res.status).toBe(200);
    expect(adminService.retryPort).toHaveBeenCalledWith('p1');
  });

  it('GET /admin/metrics returns metrics', async () => {
    adminService.getMetrics.mockResolvedValueOnce({ accounts: {}, ports: {}, dids: {} });
    const res = await request(app).get('/admin/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accounts');
  });
});
