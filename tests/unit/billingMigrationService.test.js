jest.mock('../../src/db');
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {},
  },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const svc = require('../../src/services/billingMigrationService');

beforeEach(() => {
  db.query.mockReset();
  db.withTransaction.mockReset();
});

describe('validatePromoCode', () => {
  it('parses FOX-{id} to gaiia/fox', () => {
    expect(svc.validatePromoCode('FOX-12345')).toEqual({
      provider: 'gaiia', broadband_provider: 'fox', broadband_account_id: '12345',
    });
  });
  it('parses CONF-{id} to gaiia/confluence', () => {
    expect(svc.validatePromoCode('CONF-abc-9')).toEqual({
      provider: 'gaiia', broadband_provider: 'confluence', broadband_account_id: 'abc-9',
    });
  });
  it('is case-insensitive on the prefix', () => {
    expect(svc.validatePromoCode('fox-7').broadband_provider).toBe('fox');
  });
  it('defaults to telgoo5 for unknown or missing codes', () => {
    expect(svc.validatePromoCode('SUMMER25')).toEqual({ provider: 'telgoo5' });
    expect(svc.validatePromoCode(undefined)).toEqual({ provider: 'telgoo5' });
    expect(svc.validatePromoCode('')).toEqual({ provider: 'telgoo5' });
  });
});

describe('determineBillingProvider', () => {
  it('returns the billing provider and broadband fields for a promo', () => {
    expect(svc.determineBillingProvider('FOX-1')).toEqual({
      billingProvider: 'gaiia', broadbandProvider: 'fox', broadbandAccountId: '1',
    });
  });
  it('returns telgoo5 with null broadband fields by default', () => {
    expect(svc.determineBillingProvider()).toEqual({
      billingProvider: 'telgoo5', broadbandProvider: null, broadbandAccountId: null,
    });
  });
});

describe('initiateMigration', () => {
  it('records a pending migration from the account current provider', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ external_billing_provider: 'telgoo5' }] }) // account
      .mockResolvedValueOnce({ rows: [{ id: 'mig-1', status: 'pending' }] }); // INSERT

    const m = await svc.initiateMigration('acc-1', {
      toProvider: 'gaiia', broadbandProvider: 'fox', broadbandAccountId: '99', reason: 'bundle',
    });

    expect(m.id).toBe('mig-1');
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO billing_migrations/);
    // params: account_id, from_provider, to_provider, broadband_provider,
    // broadband_account_id, promo_code, reason
    expect(params[0]).toBe('acc-1');
    expect(params[1]).toBe('telgoo5'); // from
    expect(params[2]).toBe('gaiia'); // to
    expect(params[3]).toBe('fox');
    expect(params[4]).toBe('99');
  });

  it('throws NOT_FOUND when the account does not exist', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(svc.initiateMigration('missing', { toProvider: 'gaiia' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requires toProvider', async () => {
    await expect(svc.initiateMigration('acc-1', {}))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'toProvider' });
  });
});

describe('completeMigration', () => {
  it('switches the account onto the target provider and marks completed', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'mig-1',
        account_id: 'acc-1',
        to_provider: 'gaiia',
        broadband_provider: 'fox',
        broadband_account_id: '99',
      }],
    });
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // UPDATE accounts
      .mockResolvedValueOnce({ rows: [{ id: 'mig-1', status: 'completed' }] }); // UPDATE migration
    db.withTransaction.mockImplementationOnce(async (fn) => fn({ query: clientQuery }));

    const m = await svc.completeMigration('mig-1');

    expect(m.status).toBe('completed');
    const [acctSql, acctParams] = clientQuery.mock.calls[0];
    expect(acctSql).toMatch(/UPDATE accounts/);
    expect(acctSql).toMatch(/external_billing_provider = \$1/);
    expect(acctSql).toMatch(/billing_migration_at = NOW\(\)/);
    expect(acctParams).toEqual(['gaiia', 'fox', '99', 'acc-1']);
  });

  it('throws NOT_FOUND for an unknown migration', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(svc.completeMigration('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('reverseMigration', () => {
  it('switches the account back to from_provider and clears broadband fields', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'mig-1', account_id: 'acc-1', from_provider: 'telgoo5' }],
    });
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // UPDATE accounts
      .mockResolvedValueOnce({ rows: [{ id: 'mig-1', status: 'reversed' }] }); // UPDATE migration
    db.withTransaction.mockImplementationOnce(async (fn) => fn({ query: clientQuery }));

    const m = await svc.reverseMigration('mig-1', 'fiber cancelled');

    expect(m.status).toBe('reversed');
    const [acctSql, acctParams] = clientQuery.mock.calls[0];
    expect(acctSql).toMatch(/broadband_provider = NULL/);
    expect(acctParams).toEqual(['telgoo5', 'acc-1']);
    const [migSql, migParams] = clientQuery.mock.calls[1];
    expect(migSql).toMatch(/status = 'reversed'/);
    expect(migParams).toEqual(['mig-1', 'fiber cancelled']);
  });
});

describe('getMigrationHistory / findMigrationByBroadband', () => {
  it('returns migrations newest-first', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'm2' }, { id: 'm1' }] });
    const rows = await svc.getMigrationHistory('acc-1');
    expect(rows).toHaveLength(2);
    expect(db.query.mock.calls[0][0]).toMatch(/ORDER BY created_at DESC/);
    expect(db.query.mock.calls[0][1]).toEqual(['acc-1']);
  });

  it('finds the latest migration for a broadband account', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'mig-1' }] });
    const m = await svc.findMigrationByBroadband('fox', '99');
    expect(m.id).toBe('mig-1');
    expect(db.query.mock.calls[0][1]).toEqual(['fox', '99']);
  });

  it('returns null without querying when broadband args are missing', async () => {
    expect(await svc.findMigrationByBroadband('fox', '')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});
