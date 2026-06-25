jest.mock('../../src/db');

const db = require('../../src/db');
const billing = require('../../src/services/billingExportService');

// A joined usage+account row as the SELECT returns it (NUMERIC come back as
// strings, mirroring pg).
function row(overrides = {}) {
  return {
    account_id: 'acc-1',
    endpoint_id: 'ep-1',
    data_total_mb: '500.000',
    plan_cap_mb: '1024.000',
    overage_mb: '0.000',
    overage_charge: '0.00',
    email: 'a@b.co',
    phone_e164: '+12085550100',
    plan: 'starter_10',
    status: 'active',
    external_billing_id: null,
    external_billing_provider: 'gaiia',
    bics_iccid: '8988000000000000001',
    ...overrides,
  };
}

beforeEach(() => {
  db.query.mockReset();
});

describe('generateMonthlyExport', () => {
  it('queries the month range and builds records for mixed plans', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        // existing Gaiia customer, starter_10 with overage
        row({
          account_id: 'acc-1',
          plan: 'starter_10',
          external_billing_id: 'gaiia-1',
          data_total_mb: '1500.000',
          plan_cap_mb: '1024.000',
          overage_mb: '476.000',
          overage_charge: '0.93',
        }),
        // new mobile-only, unlimited_25 (throttled, no overage charge)
        row({
          account_id: 'acc-2',
          plan: 'unlimited_25',
          external_billing_id: null,
          data_total_mb: '35000.000',
          plan_cap_mb: '30720.000',
          overage_mb: '4280.000',
          overage_charge: '0.00',
        }),
        // new mobile-only, unlimited_25_plus with 1 GB overage
        row({
          account_id: 'acc-3',
          plan: 'unlimited_25_plus',
          external_billing_id: null,
          data_total_mb: '31744.000',
          plan_cap_mb: '30720.000',
          overage_mb: '1024.000',
          overage_charge: '2.00',
        }),
      ],
    });

    const out = await billing.generateMonthlyExport(2026, 7);

    // Query covers the half-open month range.
    expect(db.query.mock.calls[0][1]).toEqual(['2026-07-01', '2026-08-01']);

    expect(out.period).toBe('2026-07');
    expect(out.recordCount).toBe(3);
    expect(out.generatedAt).toBeDefined();
    // 10.93 + 25 + 27 = 62.93
    expect(out.totalRevenue).toBe(62.93);
    expect(out.newAccounts).toBe(2);
    expect(out.existingAccounts).toBe(1);

    const [r1, r2, r3] = out.records;
    // starter_10 — existing customer, $2/GB overage
    expect(r1.action).toBe('append');
    expect(r1.externalBillingId).toBe('gaiia-1');
    expect(r1.baseCharge).toBe(10);
    expect(r1.overageGb).toBe(1); // ceil(476/1024)
    expect(r1.overageRate).toBe(2);
    expect(r1.overageCharge).toBe(0.93);
    expect(r1.totalCharge).toBe(10.93);
    expect(r1.bicsEndpointId).toBe('ep-1');
    expect(r1.bicsIccid).toBe('8988000000000000001');

    // unlimited_25 — throttled: overage MB recorded, rate/charge 0
    expect(r2.action).toBe('create');
    expect(r2.overageRate).toBe(0);
    expect(r2.overageMb).toBe(4280);
    expect(r2.overageCharge).toBe(0);
    expect(r2.totalCharge).toBe(25);

    // unlimited_25_plus — 1 GB over → $2
    expect(r3.overageGb).toBe(1);
    expect(r3.overageRate).toBe(2);
    expect(r3.totalCharge).toBe(27);
  });

  it('sets action="create" when external_billing_id is null and "append" when set', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        row({ account_id: 'new', external_billing_id: null }),
        row({ account_id: 'existing', external_billing_id: 'gaiia-99' }),
      ],
    });
    const out = await billing.generateMonthlyExport(2026, 7);
    expect(out.records[0].action).toBe('create');
    expect(out.records[1].action).toBe('append');
    expect(out.newAccounts).toBe(1);
    expect(out.existingAccounts).toBe(1);
  });

  it('returns zero records for an empty month', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const out = await billing.generateMonthlyExport(2026, 2);
    expect(out.recordCount).toBe(0);
    expect(out.totalRevenue).toBe(0);
    expect(out.newAccounts).toBe(0);
    expect(out.existingAccounts).toBe(0);
    expect(out.records).toEqual([]);
  });

  it('rolls the year over for December', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await billing.generateMonthlyExport(2026, 12);
    expect(db.query.mock.calls[0][1]).toEqual(['2026-12-01', '2027-01-01']);
  });
});

describe('exportToCsv', () => {
  it('emits the header with action first and one row per record, with escaping', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        row({
          account_id: 'acc-1',
          email: 'weird,name@x.co', // comma → must be quoted
          external_billing_id: 'gaiia-1',
          plan: 'starter_10',
          overage_mb: '0.000',
          overage_charge: '0.00',
        }),
      ],
    });

    const csv = await billing.exportToCsv(2026, 7);
    const lines = csv.split('\n');

    expect(lines[0]).toBe(
      'action,external_billing_id,account_id,parent_account_id,email,phone,plan,'
      + 'billing_period,base_charge,data_total_mb,plan_cap_mb,overage_mb,overage_gb,'
      + 'overage_rate,overage_charge,total_charge,bics_endpoint_id,bics_iccid',
    );
    // action is the first column.
    expect(lines[0].split(',')[0]).toBe('action');
    // append, gaiia-1, acc-1, then an empty parent_account_id field.
    expect(lines[1].startsWith('append,gaiia-1,acc-1,,')).toBe(true);
    // comma-bearing email is quoted.
    expect(lines[1]).toContain('"weird,name@x.co"');
  });

  it('leaves external_billing_id empty for create rows', async () => {
    db.query.mockResolvedValueOnce({
      rows: [row({ account_id: 'acc-1', external_billing_id: null })],
    });
    const csv = await billing.exportToCsv(2026, 7);
    const dataRow = csv.split('\n')[1];
    // action="create", empty external_billing_id, acc-1, empty parent_account_id.
    expect(dataRow.startsWith('create,,acc-1,,')).toBe(true);
  });
});

describe('multi-line billing roll-up', () => {
  it('rolls a child line up under the primary external_billing_id', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        // primary, billed to gaiia-1
        row({
          account_id: 'primary-1',
          external_billing_id: 'gaiia-1',
          parent_account_id: null,
        }),
        // child line under primary-1 (its own DID/usage, no billing id of its own)
        row({
          account_id: 'child-1',
          external_billing_id: null,
          parent_account_id: 'primary-1',
          parent_external_billing_id: 'gaiia-1',
          parent_external_billing_provider: 'gaiia',
        }),
      ],
    });

    const out = await billing.generateMonthlyExport(2026, 7);
    const child = out.records.find((r) => r.accountId === 'child-1');

    expect(child.parentAccountId).toBe('primary-1');
    // Charges consolidate under the primary's billing account.
    expect(child.externalBillingId).toBe('gaiia-1');
    expect(child.externalBillingProvider).toBe('gaiia');
    expect(child.action).toBe('append');
  });
});

describe('getAccountBillingSummary', () => {
  it('returns the billing record when usage exists', async () => {
    db.query.mockResolvedValueOnce({
      rows: [row({ account_id: 'acc-1', external_billing_id: 'gaiia-7' })],
    });
    const summary = await billing.getAccountBillingSummary('acc-1', 2026, 7);
    expect(summary.accountId).toBe('acc-1');
    expect(summary.action).toBe('append');
    expect(summary.billingPeriod).toBe('2026-07');
    // scoped to the account + month range
    expect(db.query.mock.calls[0][1]).toEqual(['acc-1', '2026-07-01', '2026-08-01']);
  });

  it('returns null when no usage data exists', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await billing.getAccountBillingSummary('acc-1', 2026, 7)).toBeNull();
  });
});
