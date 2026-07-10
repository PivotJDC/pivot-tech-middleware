jest.mock('../../src/db');
jest.mock('../../src/services/portOrchestrationService');

const db = require('../../src/db');
const portOrchestration = require('../../src/services/portOrchestrationService');
const adminService = require('../../src/services/adminService');

beforeEach(() => {
  db.query.mockReset();
  portOrchestration.submitPortToSignalwire.mockReset();
});

describe('listAccounts', () => {
  it('applies filters, paginates, and strips secrets', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 2 }] }) // COUNT
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'a1', email: 'a@b.co', status: 'active', sip_password_hash: 'h',
          },
          {
            id: 'a2', email: 'c@d.co', status: 'active', sip_password_hash: 'h',
          },
        ],
      });

    const result = await adminService.listAccounts({
      status: 'active', market: 'lewiston-id', limit: '10', offset: '5',
    });

    const countParams = db.query.mock.calls[0][1];
    const pageParams = db.query.mock.calls[1][1];
    expect(countParams).toEqual(['active', 'lewiston-id']);
    expect(pageParams).toEqual(['active', 'lewiston-id', 10, 5]);
    expect(result.pagination).toEqual({ limit: 10, offset: 5, total: 2 });
    expect(result.accounts[0]).not.toHaveProperty('sip_password_hash');
  });

  it('applies a free-text search across email + phone', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] }) // COUNT
      .mockResolvedValueOnce({ rows: [{ id: 'a1', email: 'jane@b.co', status: 'active' }] });

    await adminService.listAccounts({ search: '208555' });

    const countParams = db.query.mock.calls[0][1];
    const countSql = db.query.mock.calls[0][0];
    expect(countParams).toEqual(['%208555%']);
    expect(countSql).toContain('email ILIKE');
    expect(countSql).toContain('phone_e164 ILIKE');
  });

  it('clamps limit to the max and defaults offset', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
    const result = await adminService.listAccounts({ limit: '9999' });
    expect(result.pagination.limit).toBe(100);
    expect(result.pagination.offset).toBe(0);
  });
});

describe('getAccountUsageStats', () => {
  it('returns the mapped stats as numbers from a single query', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        data_used_mb: '12400.500',
        data_cap_mb: '30720.000',
        voice_minutes: 47,
        sms_count: '23',
        mms_count: '2',
      }],
    });

    const stats = await adminService.getAccountUsageStats('acc-1');

    expect(stats).toEqual({
      data_used_mb: 12400.5,
      data_cap_mb: 30720,
      voice_minutes: 47,
      sms_count: 23,
      mms_count: 2,
    });
    // Single query, parameterized by account id.
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1]).toEqual(['acc-1']);
    // Pulls from all three sources, scoped to the current month.
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/usage_records/);
    expect(sql).toMatch(/call_records/);
    expect(sql).toMatch(/message_records/);
    expect(sql).toMatch(/date_trunc\('month'/);
  });

  it('defaults to zeros when there is no data', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        data_used_mb: 0, data_cap_mb: 0, voice_minutes: 0, sms_count: 0, mms_count: 0,
      }],
    });
    const stats = await adminService.getAccountUsageStats('acc-2');
    expect(stats).toEqual({
      data_used_mb: 0, data_cap_mb: 0, voice_minutes: 0, sms_count: 0, mms_count: 0,
    });
  });
});

describe('getHourlyActivity', () => {
  it('returns hour/calls/messages as numbers, scoped to the current month', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { hour: 0, calls: '2', messages: '5' },
        { hour: 1, calls: 0, messages: 0 },
      ],
    });

    const rows = await adminService.getHourlyActivity();

    expect(rows[0]).toEqual({ hour: 0, calls: 2, messages: 5 });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/generate_series\(0, 23\)/);
    expect(sql).toMatch(/EXTRACT\(HOUR FROM created_at\)/);
    expect(sql).toMatch(/date_trunc\('month'/);
    expect(sql).toMatch(/call_records/);
    expect(sql).toMatch(/message_records/);
  });
});

describe('getUsageDistribution', () => {
  it('returns bucket/count pairs as numbers using the latest snapshot per subscriber', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { bucket: '0-1 GB', count: '42' },
        { bucket: '30+ GB', count: 3 },
      ],
    });

    const rows = await adminService.getUsageDistribution();

    expect(rows[0]).toEqual({ bucket: '0-1 GB', count: 42 });
    expect(rows[1]).toEqual({ bucket: '30+ GB', count: 3 });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/DISTINCT ON \(account_id\)/);
    expect(sql).toMatch(/data_total_mb < 1024/);
    expect(sql).toMatch(/data_total_mb < 30720/);
  });
});

describe('tenant scoping', () => {
  it('listAccounts filters by tenant_id when tenantId is given', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 1 }] }).mockResolvedValueOnce({ rows: [] });
    await adminService.listAccounts({ tenantId: 'ten-1' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/tenant_id =/);
    expect(params).toEqual(['ten-1']);
  });

  it('listAccounts does NOT filter by tenant when omitted (super_admin all-tenants)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
    await adminService.listAccounts({});
    expect(db.query.mock.calls[0][0]).not.toMatch(/tenant_id/);
  });

  it('listPorts scopes via the owning account subquery', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
    await adminService.listPorts({ tenantId: 'ten-1' });
    expect(db.query.mock.calls[0][0]).toMatch(/account_id IN \(SELECT id FROM accounts WHERE tenant_id/);
  });

  it('getMetrics scopes each count to the tenant', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await adminService.getMetrics('ten-1');
    expect(db.query.mock.calls[0][1]).toEqual(['ten-1']); // accounts
    expect(db.query.mock.calls[1][0]).toMatch(/account_id IN \(SELECT id FROM accounts WHERE tenant_id/); // ports
    expect(db.query.mock.calls[2][1]).toEqual(['ten-1']); // dids
  });

  it('getHourlyActivity + getUsageTrends + getBillingReconciliation scope by tenant', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await adminService.getHourlyActivity('ten-1');
    expect(db.query.mock.calls[0][0]).toMatch(/AND tenant_id = \$1/);
    expect(db.query.mock.calls[0][1]).toEqual(['ten-1']);

    db.query.mockClear();
    await adminService.getUsageTrends('day', 'ten-1');
    expect(db.query.mock.calls[0][1]).toEqual(['ten-1']);

    db.query.mockClear();
    db.query.mockResolvedValue({ rows: [{}] });
    await adminService.getBillingReconciliation('2026-07-01', '2026-07-31', 'ten-1');
    expect(db.query.mock.calls[0][1]).toEqual(['2026-07-01', '2026-07-31', 'ten-1']);
  });
});

describe('getHourlyDataVoice', () => {
  it('returns hour/voice_minutes/call_count as numbers for the current month', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ hour: 9, voice_minutes: '12', call_count: '4' }],
    });
    const rows = await adminService.getHourlyDataVoice();
    expect(rows[0]).toEqual({ hour: 9, voice_minutes: 12, call_count: 4 });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/generate_series\(0, 23\)/);
    expect(sql).toMatch(/SUM\(duration_seconds\)/);
    expect(sql).toMatch(/call_records/);
    expect(sql).toMatch(/date_trunc\('month'/);
  });
});

describe('getHourlyMessages', () => {
  it('splits by direction into sent/received per hour', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ hour: 10, sent: '7', received: '3' }],
    });
    const rows = await adminService.getHourlyMessages();
    expect(rows[0]).toEqual({ hour: 10, sent: 7, received: 3 });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/FILTER \(WHERE direction = 'outbound'\)/);
    expect(sql).toMatch(/FILTER \(WHERE direction = 'inbound'\)/);
    expect(sql).toMatch(/message_records/);
  });
});

describe('getUsageTrends', () => {
  it('buckets by day over the last 30 days (default) and maps Date labels', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ label: new Date('2026-07-01T00:00:00Z'), total_mb: '45000.500' }],
    });
    const rows = await adminService.getUsageTrends('day');
    expect(rows[0]).toEqual({ label: '2026-07-01', total_mb: 45000.5 });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/period_end AS label/);
    expect(sql).toMatch(/interval '30 days'/);
  });

  it('buckets by ISO week over the last 12 weeks', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await adminService.getUsageTrends('week');
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/date_trunc\('week', period_end\)::date/);
    expect(sql).toMatch(/interval '12 weeks'/);
  });

  it('buckets by month over the last 12 months', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await adminService.getUsageTrends('month');
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/date_trunc\('month', period_end\)::date/);
    expect(sql).toMatch(/interval '12 months'/);
  });

  it('falls back to the day query for an unknown period', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await adminService.getUsageTrends('century');
    expect(db.query.mock.calls[0][0]).toMatch(/interval '30 days'/);
  });
});

describe('getBillingReconciliation', () => {
  it('aggregates Telnyx volumes + BICS data and computes GB/cost', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          voice_minutes: 120, voice_calls: '40', sms_count: '15', mms_count: '3',
        }],
      }) // telnyx aggregate
      .mockResolvedValueOnce({ rows: [{ data_total_mb: '20480.000', data_cost: 0 }] }); // bics

    const report = await adminService.getBillingReconciliation('2026-07-01', '2026-07-31');

    expect(report.period).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(report.telnyx).toEqual({
      voice_minutes: 120, voice_calls: 40, sms_count: 15, mms_count: 3,
    });
    // 20480 MB = 20 GB; no carrier cost -> blended $2/GB = $40.
    expect(report.bics).toEqual({
      data_total_mb: 20480,
      data_total_gb: 20,
      estimated_cost: 40,
    });
    // Both queries scoped to the range.
    expect(db.query.mock.calls[0][1]).toEqual(['2026-07-01', '2026-07-31']);
    expect(db.query.mock.calls[1][1]).toEqual(['2026-07-01', '2026-07-31']);
    // End date is inclusive: upper bound is the "to" date + 1 day.
    expect(db.query.mock.calls[1][0]).toMatch(
      /period_start >= \$1::date AND period_end <= \(\$2::date \+ interval '1 day'\)/,
    );
    // Telnyx subqueries include the full "to" date too.
    expect(db.query.mock.calls[0][0]).toMatch(
      /created_at BETWEEN \$1::date AND \(\$2::date \+ interval '1 day'\)/,
    );
  });

  it('prefers the carrier-reported data_cost when present', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          voice_minutes: 0, voice_calls: 0, sms_count: 0, mms_count: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ data_total_mb: '10240', data_cost: '17.500' }] });

    const report = await adminService.getBillingReconciliation('2026-06-01', '2026-06-30');
    expect(report.bics.data_total_gb).toBe(10);
    expect(report.bics.estimated_cost).toBe(17.5); // carrier cost, not blended
  });

  it('returns zeros when there is no activity', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          voice_minutes: 0, voice_calls: 0, sms_count: 0, mms_count: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ data_total_mb: 0, data_cost: 0 }] });

    const report = await adminService.getBillingReconciliation('2026-05-01', '2026-05-31');
    expect(report.telnyx).toEqual({
      voice_minutes: 0, voice_calls: 0, sms_count: 0, mms_count: 0,
    });
    expect(report.bics).toEqual({ data_total_mb: 0, data_total_gb: 0, estimated_cost: 0 });
  });
});

describe('listDids', () => {
  it('filters by market/status/area_code', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 1 }] }).mockResolvedValueOnce({ rows: [{ id: 'd1' }] });
    const result = await adminService.listDids({ market: 'lewiston-id', status: 'available', area_code: '208' });
    expect(db.query.mock.calls[0][1]).toEqual(['lewiston-id', 'available', '208']);
    expect(result.dids).toHaveLength(1);
  });

  it('searches by phone number (e164 ILIKE)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 1 }] }).mockResolvedValueOnce({ rows: [{ id: 'd1' }] });
    await adminService.listDids({ search: '208555' });
    expect(db.query.mock.calls[0][0]).toMatch(/e164 ILIKE/);
    expect(db.query.mock.calls[0][1]).toEqual(['%208555%']);
  });
});

describe('listPorts', () => {
  it('strips pin_encrypted from results', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'p1', status: 'failed', pin_encrypted: 'iv:tag:ct' }] });
    const result = await adminService.listPorts({ status: 'failed' });
    expect(result.ports[0]).not.toHaveProperty('pin_encrypted');
    expect(result.ports[0].id).toBe('p1');
  });
});

describe('listPortOrders', () => {
  it('lists FastPort port orders and strips encrypted secrets', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'po1',
          status: 'submitted',
          pin_encrypted: 'iv:tag:ct',
          account_number_encrypted: 'iv:tag:ct2',
        }],
      });
    const result = await adminService.listPortOrders({ status: 'submitted' });
    expect(result.port_orders[0]).not.toHaveProperty('pin_encrypted');
    expect(result.port_orders[0]).not.toHaveProperty('account_number_encrypted');
    expect(result.port_orders[0].id).toBe('po1');
    expect(db.query.mock.calls[0][0]).toContain('FROM port_orders');
  });

  it('scopes to a tenant via the owning account subquery', async () => {
    db.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await adminService.listPortOrders({ tenantId: 'ten-1' });
    expect(db.query.mock.calls[0][0]).toContain('account_id IN (SELECT id FROM accounts WHERE tenant_id');
  });
});

describe('getPortOrder', () => {
  it('returns one order with secrets stripped', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'po1', status: 'submitted', pin_encrypted: 'x', account_number_encrypted: 'y',
      }],
    });
    const result = await adminService.getPortOrder('po1', null);
    expect(result.id).toBe('po1');
    expect(result).not.toHaveProperty('pin_encrypted');
  });

  it('throws NOT_FOUND when the order is absent or out of tenant scope', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(adminService.getPortOrder('nope', 'ten-1'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('retryPort', () => {
  it('resubmits a failed port and clears the failure', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'p1', status: 'failed', pin_encrypted: 'enc', number_e164: '+12085550100',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'p1', status: 'submitted', pin_encrypted: 'enc' }] });
    portOrchestration.submitPortToSignalwire.mockResolvedValueOnce({ signalwirePortId: 'swp9' });

    const result = await adminService.retryPort('p1');

    expect(portOrchestration.submitPortToSignalwire).toHaveBeenCalled();
    expect(db.query.mock.calls[1][1]).toEqual(['p1', 'swp9']);
    expect(result.status).toBe('submitted');
    expect(result).not.toHaveProperty('pin_encrypted');
  });

  it('throws NOT_FOUND for a missing port', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(adminService.retryPort('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to retry a port that is not failed', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1', status: 'pending' }] });
    await expect(adminService.retryPort('p1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(portOrchestration.submitPortToSignalwire).not.toHaveBeenCalled();
  });
});

describe('getMetrics', () => {
  it('aggregates account, port, and DID counts with a success rate', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ status: 'active', count: 5 }, { status: 'pending', count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ status: 'completed', count: 8 }, { status: 'failed', count: 2 }] })
      .mockResolvedValueOnce({ rows: [{ status: 'available', count: 10 }, { status: 'assigned', count: 3 }] });

    const metrics = await adminService.getMetrics();

    expect(metrics.accounts).toMatchObject({ total: 6, active: 5, pending: 1 });
    expect(metrics.ports).toMatchObject({
      total: 10, completed: 8, failed: 2, success_rate: 0.8,
    });
    expect(metrics.dids).toMatchObject({ total: 13, available: 10, assigned: 3 });
  });

  it('reports null success rate when there are no finished ports', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const metrics = await adminService.getMetrics();
    expect(metrics.ports.success_rate).toBeNull();
  });
});
