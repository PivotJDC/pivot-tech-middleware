// Tenant isolation at the admin route layer: what tenant a read is scoped to
// depends on the caller's role (super_admin = all / overridable; scoped admin =
// their own tenant, override ignored).
let mockAdmin = { id: 'jim', role: 'super_admin' };

jest.mock('../../src/middleware/adminAuth', () => {
  const actual = jest.requireActual('../../src/middleware/adminAuth');
  return { ...actual, adminAuth: (req, res, next) => { req.admin = mockAdmin; next(); } };
});
jest.mock('../../src/middleware/rateLimiter', () => ({ rateLimit: () => (req, res, next) => next() }));
jest.mock('../../src/services/adminService');
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/provisioningService');
jest.mock('../../src/services/adminUserService');
jest.mock('../../src/services/cdrService');
jest.mock('../../src/services/usageService');
jest.mock('../../src/services/tenantService');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const express = require('express');
const request = require('supertest');
const adminService = require('../../src/services/adminService');
const adminRouter = require('../../src/routes/admin');
const { errorHandler } = require('../../src/middleware/errorHandler');

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  adminService.listAccounts.mockResolvedValue({ accounts: [], pagination: {} });
});

/** The tenantId that GET /admin/accounts forwarded to the service. */
function scopedTenant() {
  return adminService.listAccounts.mock.calls[0][0].tenantId;
}

describe('admin read tenant scope', () => {
  it('super_admin: no tenant filter (sees all tenants)', async () => {
    mockAdmin = { id: 'jim', role: 'super_admin' };
    await request(app).get('/admin/accounts');
    expect(scopedTenant()).toBeNull();
  });

  it('super_admin: can override via ?tenant_id=', async () => {
    mockAdmin = { id: 'jim', role: 'super_admin' };
    await request(app).get('/admin/accounts?tenant_id=ten-9');
    expect(scopedTenant()).toBe('ten-9');
  });

  it('scoped admin: forced to their own tenant', async () => {
    mockAdmin = { id: 'bob', role: 'admin', tenant_id: 'ten-bob' };
    await request(app).get('/admin/accounts');
    expect(scopedTenant()).toBe('ten-bob');
  });

  it('scoped admin: a ?tenant_id override is IGNORED (isolation)', async () => {
    mockAdmin = { id: 'bob', role: 'admin', tenant_id: 'ten-bob' };
    await request(app).get('/admin/accounts?tenant_id=ten-other');
    expect(scopedTenant()).toBe('ten-bob'); // not ten-other
  });

  it('viewer: also forced to their own tenant', async () => {
    mockAdmin = { id: 'v', role: 'viewer', tenant_id: 'ten-v' };
    await request(app).get('/admin/accounts');
    expect(scopedTenant()).toBe('ten-v');
  });
});

describe('GET /admin/tenants/:id/accounts (super_admin cross-tenant view)', () => {
  it('scopes to the path tenant id', async () => {
    mockAdmin = { id: 'jim', role: 'super_admin' };
    await request(app).get('/admin/tenants/ten-7/accounts');
    expect(adminService.listAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'ten-7' }),
    );
  });
});
