jest.mock('../../src/services/tenantService');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const tenantService = require('../../src/services/tenantService');
const { tenantResolver } = require('../../src/middleware/tenantResolver');

function run(req) {
  const next = jest.fn();
  return tenantResolver(req, {}, next).then(() => ({ req, next }));
}

beforeEach(() => jest.clearAllMocks());

describe('tenantResolver', () => {
  it('resolves by Host header domain first', async () => {
    tenantService.getTenantByDomain.mockResolvedValueOnce({ id: 't-acme', slug: 'acme' });
    const { req, next } = await run({ headers: { host: 'acme.io:443' } });
    expect(tenantService.getTenantByDomain).toHaveBeenCalledWith('acme.io'); // port stripped
    expect(req.tenant).toEqual({ id: 't-acme', slug: 'acme' });
    expect(next).toHaveBeenCalled();
    // Did not need the other strategies.
    expect(tenantService.getTenantBySlug).not.toHaveBeenCalled();
  });

  it('falls back to the x-tenant-slug header', async () => {
    tenantService.getTenantByDomain.mockResolvedValueOnce(null);
    tenantService.getTenantBySlug.mockResolvedValueOnce({ id: 't2', slug: 'beta' });
    const { req } = await run({ headers: { host: 'unknown.io', 'x-tenant-slug': 'beta' } });
    expect(tenantService.getTenantBySlug).toHaveBeenCalledWith('beta');
    expect(req.tenant.slug).toBe('beta');
  });

  it('falls back to a JWT tenant_id claim', async () => {
    tenantService.getTenantByDomain.mockResolvedValueOnce(null);
    tenantService.getTenantById.mockResolvedValueOnce({ id: 't3' });
    const { req } = await run({ headers: { host: 'x.io' }, auth: { claims: { tenant_id: 't3' } } });
    expect(tenantService.getTenantById).toHaveBeenCalledWith('t3');
    expect(req.tenant.id).toBe('t3');
  });

  it('defaults to the MobilityNet tenant when nothing matches', async () => {
    tenantService.getTenantByDomain.mockResolvedValueOnce(null);
    tenantService.getDefaultTenant.mockResolvedValueOnce({ id: 'default', slug: 'mobilitynet' });
    const { req } = await run({ headers: {} });
    expect(tenantService.getDefaultTenant).toHaveBeenCalled();
    expect(req.tenant.slug).toBe('mobilitynet');
  });

  it('never throws: a lookup failure still calls next with req.tenant', async () => {
    tenantService.getTenantByDomain.mockRejectedValueOnce(new Error('db down'));
    tenantService.getDefaultTenant.mockRejectedValueOnce(new Error('db down'));
    const { req, next } = await run({ headers: { host: 'acme.io' } });
    expect(req.tenant).toBeNull();
    expect(next).toHaveBeenCalled();
  });
});
