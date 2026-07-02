jest.mock('../../src/db');

const db = require('../../src/db');
const tenantService = require('../../src/services/tenantService');

beforeEach(() => db.query.mockReset());

describe('createTenant', () => {
  it('inserts with normalized slug and JSON-encoded config, returns the row', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 't1', slug: 'acme', name: 'Acme' }] });

    const tenant = await tenantService.createTenant({
      slug: '  ACME ', name: 'Acme', domain: 'acme.io', plans: [{ id: 'p1' }],
    });

    expect(tenant).toMatchObject({ id: 't1' });
    const params = db.query.mock.calls[0][1];
    expect(params[0]).toBe('acme'); // slug lowercased + trimmed
    expect(params[1]).toBe('Acme');
    expect(params[2]).toBe('acme.io');
    expect(params[4]).toBe('{}'); // brand_config default JSON
    expect(params[5]).toBe('[{"id":"p1"}]'); // plans JSON-encoded
    expect(params[6]).toEqual([]); // bics_sim_range as an array
    expect(params[10]).toBe('onboarding'); // default status
  });

  it.each([
    [{ name: 'Acme' }, 'slug'],
    [{ slug: 'acme' }, 'name'],
    [{ slug: 'acme', name: 'Acme', status: 'bogus' }, 'status'],
  ])('rejects invalid input (%o)', async (input, field) => {
    await expect(tenantService.createTenant(input))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('maps a unique-violation to a 409 conflict', async () => {
    db.query.mockRejectedValueOnce({ code: '23505' });
    await expect(tenantService.createTenant({ slug: 'dup', name: 'Dup' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 409, field: 'slug' });
  });
});

describe('lookups', () => {
  it('getTenantById returns the row or null', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 't1' }] });
    expect(await tenantService.getTenantById('t1')).toEqual({ id: 't1' });
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await tenantService.getTenantById('missing')).toBeNull();
  });

  it('getTenantBySlug + getTenantByDomain normalize the lookup value', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 't1' }] });
    await tenantService.getTenantBySlug('  ACME ');
    expect(db.query.mock.calls[0][1]).toEqual(['acme']);
    await tenantService.getTenantByDomain('ACME.IO');
    expect(db.query.mock.calls[1][1]).toEqual(['acme.io']);
  });

  it('getDefaultTenant queries the seeded MobilityNet id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: tenantService.DEFAULT_TENANT_ID }] });
    const t = await tenantService.getDefaultTenant();
    expect(db.query.mock.calls[0][1]).toEqual([tenantService.DEFAULT_TENANT_ID]);
    expect(t.id).toBe(tenantService.DEFAULT_TENANT_ID);
  });
});

describe('listTenants', () => {
  it('filters by status and paginates', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 2 }] }) // COUNT
      .mockResolvedValueOnce({ rows: [{ id: 't1' }, { id: 't2' }] });
    const res = await tenantService.listTenants({ status: 'active', limit: '10', offset: '5' });
    expect(db.query.mock.calls[0][1]).toEqual(['active']);
    expect(db.query.mock.calls[1][1]).toEqual(['active', 10, 5]);
    expect(res.pagination).toEqual({ limit: 10, offset: 5, total: 2 });
    expect(res.tenants).toHaveLength(2);
  });

  it('works without a status filter', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
    await tenantService.listTenants({});
    expect(db.query.mock.calls[0][1]).toEqual([]);
  });
});

describe('updateTenant', () => {
  it('builds a dynamic SET for provided fields (JSON-encoding blobs)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 't1', name: 'New' }] });
    await tenantService.updateTenant('t1', { name: 'New', brand_config: { color: 'cyan' } });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE tenants SET/);
    expect(sql).toMatch(/updated_at = NOW\(\)/);
    expect(params).toEqual(['New', '{"color":"cyan"}', 't1']);
  });

  it('accepts the onboarding-wizard blobs together (brand_config, plans, billing_config)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 't1' }] });
    await tenantService.updateTenant('t1', {
      name: 'FoxFi Mobile',
      domain: 'app.foxfi-mobile.com',
      roaming_profile_id: '19855',
      brand_config: { brand_name: 'FoxFi', markets: { area_codes: ['208'] } },
      plans: [{ name: 'Unlimited', monthly_price: 25 }],
      billing_config: { contract_tier: 'starter', csr_addon: true },
    });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE tenants SET/);
    // JSONB blobs are stringified; scalar columns pass through verbatim.
    expect(params).toEqual([
      'FoxFi Mobile',
      'app.foxfi-mobile.com',
      '{"brand_name":"FoxFi","markets":{"area_codes":["208"]}}',
      '[{"name":"Unlimited","monthly_price":25}]',
      '19855',
      '{"contract_tier":"starter","csr_addon":true}',
      't1',
    ]);
  });

  it('returns the current row when no updatable fields are given', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 't1' }] }); // getTenantById
    const t = await tenantService.updateTenant('t1', { not_a_field: 1 });
    expect(t).toEqual({ id: 't1' });
    expect(db.query.mock.calls[0][0]).toMatch(/SELECT \* FROM tenants/);
  });

  it('rejects an invalid status', async () => {
    await expect(tenantService.updateTenant('t1', { status: 'nope' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'status' });
  });

  it('404s when the tenant does not exist', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(tenantService.updateTenant('missing', { name: 'x' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('suspend/activate', () => {
  it('suspendTenant sets status=suspended', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 't1', status: 'suspended' }] });
    const t = await tenantService.suspendTenant('t1');
    expect(db.query.mock.calls[0][1]).toEqual(['suspended', 't1']);
    expect(t.status).toBe('suspended');
  });

  it('activateTenant sets status=active', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 't1', status: 'active' }] });
    await tenantService.activateTenant('t1');
    expect(db.query.mock.calls[0][1]).toEqual(['active', 't1']);
  });

  it('404s a missing tenant', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(tenantService.activateTenant('missing'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
