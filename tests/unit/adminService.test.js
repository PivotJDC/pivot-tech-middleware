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

  it('clamps limit to the max and defaults offset', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
    const result = await adminService.listAccounts({ limit: '9999' });
    expect(result.pagination.limit).toBe(100);
    expect(result.pagination.offset).toBe(0);
  });
});

describe('listDids', () => {
  it('filters by market/status/area_code', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 1 }] }).mockResolvedValueOnce({ rows: [{ id: 'd1' }] });
    const result = await adminService.listDids({ market: 'lewiston-id', status: 'available', area_code: '208' });
    expect(db.query.mock.calls[0][1]).toEqual(['lewiston-id', 'available', '208']);
    expect(result.dids).toHaveLength(1);
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
