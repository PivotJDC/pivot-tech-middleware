jest.mock('../../src/db');
jest.mock('../../src/integrations/bics');
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {},
  },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const bics = require('../../src/integrations/bics');
const usageService = require('../../src/services/usageService');

// Fixed clock: 24 June 2026 (UTC) → period 2026-06-01 .. 2026-06-24.
const NOW = new Date(Date.UTC(2026, 5, 24));

/** Build a BICS statistics responseParam with the given total MB. */
function stats({
  totalVolume, uplink = 0, downlink = 0, totalCost = 0, smsCount = 0,
}) {
  return {
    dataTotalUsage: {
      uplink: String(uplink),
      downlink: String(downlink),
      totalVolume: String(totalVolume),
      totalCost: String(totalCost),
    },
    smsTotalUsage: { count: String(smsCount) },
  };
}

// Pull the INSERT params back out of the mocked db.query call.
function lastUpsertParams() {
  const call = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO usage_records'));
  return call[1];
}

beforeEach(() => {
  db.query.mockReset();
  bics.getEndpointStatistics.mockReset();
  // Default: the UPSERT echoes a row back.
  db.query.mockResolvedValue({ rows: [{ id: 'usage-1' }] });
});

describe('pollUsageForAccount', () => {
  const account = { id: 'acc-1', bics_endpoint_id: 'ep-1', plan: 'starter_10' };

  it('queries BICS for the current billing period and persists the record', async () => {
    bics.getEndpointStatistics.mockResolvedValueOnce(stats({
      totalVolume: 500, uplink: 100, downlink: 400, totalCost: 0.12, smsCount: 7,
    }));

    const row = await usageService.pollUsageForAccount(account, NOW);
    expect(row).toEqual({ id: 'usage-1' });

    expect(bics.getEndpointStatistics).toHaveBeenCalledWith('ep-1', '20260601', '20260624');

    const params = lastUpsertParams();
    expect(params[0]).toBe('acc-1'); // account_id
    expect(params[1]).toBe('ep-1'); // endpoint_id
    expect(params[2]).toBe('2026-06-01'); // period_start
    expect(params[3]).toBe('2026-06-24'); // period_end
    expect(params[6]).toBe(500); // data_total_mb
    expect(params[8]).toBe(7); // sms_count
    expect(params[9]).toBe(1024); // plan_data_cap_mb
  });

  it('starter_10: charges $2/GB on overage', async () => {
    // 1500 MB used, 1024 cap → 476 MB over → 476/1024*2 = 0.9296.. → 0.93
    bics.getEndpointStatistics.mockResolvedValueOnce(stats({ totalVolume: 1500 }));
    await usageService.pollUsageForAccount({ id: 'a', bics_endpoint_id: 'ep', plan: 'starter_10' }, NOW);
    const params = lastUpsertParams();
    expect(params[10]).toBe(476); // overage_mb
    expect(params[11]).toBe(0.93); // overage_charge
  });

  it('starter_10: no overage when under the cap', async () => {
    bics.getEndpointStatistics.mockResolvedValueOnce(stats({ totalVolume: 800 }));
    await usageService.pollUsageForAccount({ id: 'a', bics_endpoint_id: 'ep', plan: 'starter_10' }, NOW);
    const params = lastUpsertParams();
    expect(params[10]).toBe(0); // overage_mb
    expect(params[11]).toBe(0); // overage_charge
  });

  it('unlimited_25: throttled — records overage MB but charges $0', async () => {
    // 35000 MB used, 30720 cap → 4280 MB over, but throttled so charge 0.
    bics.getEndpointStatistics.mockResolvedValueOnce(stats({ totalVolume: 35000 }));
    await usageService.pollUsageForAccount({ id: 'a', bics_endpoint_id: 'ep', plan: 'unlimited_25' }, NOW);
    const params = lastUpsertParams();
    expect(params[9]).toBe(30720); // cap
    expect(params[10]).toBe(4280); // overage_mb still recorded
    expect(params[11]).toBe(0); // overage_charge = 0 (throttled)
  });

  it('unlimited_25_plus: charges $2/GB beyond 30 GB', async () => {
    // 31744 MB used, 30720 cap → 1024 MB over → exactly 1 GB → $2.00
    bics.getEndpointStatistics.mockResolvedValueOnce(stats({ totalVolume: 31744 }));
    await usageService.pollUsageForAccount({ id: 'a', bics_endpoint_id: 'ep', plan: 'unlimited_25_plus' }, NOW);
    const params = lastUpsertParams();
    expect(params[10]).toBe(1024); // overage_mb
    expect(params[11]).toBe(2); // overage_charge
  });

  it('throws on an account with no BICS endpoint', async () => {
    await expect(usageService.pollUsageForAccount({ id: 'a', plan: 'starter_10' }, NOW))
      .rejects.toThrow(/bics_endpoint_id/);
    expect(bics.getEndpointStatistics).not.toHaveBeenCalled();
  });

  it('throws on an unknown plan', async () => {
    await expect(usageService.pollUsageForAccount({ id: 'a', bics_endpoint_id: 'ep', plan: 'mystery' }, NOW)).rejects.toThrow(/unknown plan/);
  });
});

describe('UPSERT behavior', () => {
  it('keys the conflict on account_id + period_start + period_end', async () => {
    bics.getEndpointStatistics.mockResolvedValue(stats({ totalVolume: 100 }));
    await usageService.pollUsageForAccount({ id: 'a', bics_endpoint_id: 'ep', plan: 'starter_10' }, NOW);
    const [sql] = db.query.mock.calls.find(([s]) => s.includes('INSERT INTO usage_records'));
    expect(sql).toMatch(/ON CONFLICT \(account_id, period_start, period_end\)/);
    expect(sql).toMatch(/DO UPDATE SET/);
  });

  it('re-polling the SAME period reuses the same conflict key (update)', async () => {
    bics.getEndpointStatistics.mockResolvedValue(stats({ totalVolume: 100 }));
    const account = { id: 'a', bics_endpoint_id: 'ep', plan: 'starter_10' };
    await usageService.pollUsageForAccount(account, NOW);
    await usageService.pollUsageForAccount(account, NOW);

    const upserts = db.query.mock.calls.filter(([s]) => s.includes('INSERT INTO usage_records'));
    expect(upserts).toHaveLength(2);
    // Same period boundaries → same conflict key → DB updates in place.
    expect(upserts[0][1].slice(2, 4)).toEqual(['2026-06-01', '2026-06-24']);
    expect(upserts[1][1].slice(2, 4)).toEqual(['2026-06-01', '2026-06-24']);
  });

  it('a DIFFERENT month yields a different conflict key (insert)', async () => {
    bics.getEndpointStatistics.mockResolvedValue(stats({ totalVolume: 100 }));
    const account = { id: 'a', bics_endpoint_id: 'ep', plan: 'starter_10' };
    await usageService.pollUsageForAccount(account, NOW);
    await usageService.pollUsageForAccount(account, new Date(Date.UTC(2026, 6, 5))); // July 5

    const upserts = db.query.mock.calls.filter(([s]) => s.includes('INSERT INTO usage_records'));
    expect(upserts[0][1].slice(2, 4)).toEqual(['2026-06-01', '2026-06-24']);
    expect(upserts[1][1].slice(2, 4)).toEqual(['2026-07-01', '2026-07-05']);
  });
});

describe('pollAllActiveAccounts', () => {
  it('isolates per-account failures and reports a summary', async () => {
    const accounts = [
      { id: 'acc-1', bics_endpoint_id: 'ep-1', plan: 'starter_10' },
      { id: 'acc-2', bics_endpoint_id: 'ep-2', plan: 'unlimited_25' },
      { id: 'acc-3', bics_endpoint_id: 'ep-3', plan: 'unlimited_25_plus' },
    ];
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM accounts')) return Promise.resolve({ rows: accounts });
      return Promise.resolve({ rows: [{ id: 'usage' }] }); // UPSERT
    });
    bics.getEndpointStatistics.mockImplementation((endpointId) => {
      if (endpointId === 'ep-2') return Promise.reject(new Error('BICS down'));
      return Promise.resolve(stats({ totalVolume: 100 }));
    });

    const result = await usageService.pollAllActiveAccounts(NOW);
    expect(result.polled).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([{ accountId: 'acc-2', error: 'BICS down' }]);
  });

  it('only selects active accounts that have a BICS endpoint', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await usageService.pollAllActiveAccounts(NOW);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/status = 'active'/);
    expect(sql).toMatch(/bics_endpoint_id IS NOT NULL/);
  });
});

describe('getUsageForAccount', () => {
  it('returns the latest record', async () => {
    const record = { id: 'usage-9', account_id: 'acc-1', data_total_mb: '123.000' };
    db.query.mockResolvedValueOnce({ rows: [record] });
    const res = await usageService.getUsageForAccount('acc-1');
    expect(res).toBe(record);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY period_end DESC/);
    expect(sql).toMatch(/LIMIT 1/);
    expect(params).toEqual(['acc-1']);
  });

  it('returns null when the account has no usage', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await usageService.getUsageForAccount('acc-1')).toBeNull();
  });
});

describe('getUsageSummaryForPeriod', () => {
  it('maps the aggregate row to numbers', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        total_accounts: '5',
        total_data_mb: '1000.500',
        total_overage_mb: '200.000',
        total_overage_charges: '12.50',
        total_sms_counts: '42',
      }],
    });
    const res = await usageService.getUsageSummaryForPeriod('2026-06-01', '2026-06-30');
    expect(res).toEqual({
      totalAccounts: 5,
      totalDataMb: 1000.5,
      totalOverageMb: 200,
      totalOverageCharges: 12.5,
      totalSmsCounts: 42,
    });
    const [, params] = db.query.mock.calls[0];
    expect(params).toEqual(['2026-06-01', '2026-06-30']);
  });
});
