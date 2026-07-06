jest.mock('../../src/db');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const cdr = require('../../src/services/cdrService');

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OUR_DID = '+12085550100';
const OTHER = '+12085550142';

beforeEach(() => {
  db.query.mockReset();
});

describe('recordCall', () => {
  it('inserts a new outbound call owned by the from-number account', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, tenant_id: 'ten-1' }] }) // accountIdForNumber(from)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (no existing row)
      .mockResolvedValueOnce({ rows: [{ id: 'cr-1', direction: 'outbound' }] }); // INSERT

    const row = await cdr.recordCall({
      callSid: 'CA1',
      direction: 'outbound',
      from: OUR_DID,
      to: OTHER,
      status: 'completed',
      durationSeconds: 42,
    });

    expect(row).toMatchObject({ id: 'cr-1', direction: 'outbound' });
    // Lookup used the from-number for an outbound call.
    expect(db.query.mock.calls[0][1]).toEqual([OUR_DID]);
    const insertParams = db.query.mock.calls[2][1];
    expect(insertParams[0]).toBe(ACCOUNT_ID);
    expect(insertParams[1]).toBe('ten-1'); // tenant_id
    expect(insertParams[3]).toBe('outbound');
    expect(insertParams[7]).toBe(42); // duration
  });

  it('updates an existing call (upsert by call_sid) without inserting', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, tenant_id: 'ten-1' }] }) // lookup
      .mockResolvedValueOnce({ rows: [{ id: 'cr-1', status: 'completed' }] }); // UPDATE hit

    const row = await cdr.recordCall({
      callSid: 'CA1', direction: 'outbound', from: OUR_DID, to: OTHER, status: 'completed',
    });

    expect(row).toMatchObject({ id: 'cr-1' });
    expect(db.query).toHaveBeenCalledTimes(2); // no INSERT
    expect(db.query.mock.calls[1][0]).toMatch(/UPDATE call_records/);
  });

  it('infers inbound direction when no direction is given and the to-number is ours', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // from not ours
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, tenant_id: 'ten-1' }] }) // to is ours -> inbound
      .mockResolvedValueOnce({ rows: [] }) // UPDATE miss
      .mockResolvedValueOnce({ rows: [{ id: 'cr-2', direction: 'inbound' }] }); // INSERT

    const row = await cdr.recordCall({
      callSid: 'CA2', from: OTHER, to: OUR_DID, status: 'ringing',
    });

    expect(row.direction).toBe('inbound');
    expect(db.query.mock.calls[3][1][3]).toBe('inbound');
  });

  it('ignores a call for a number we do not own', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // from lookup (outbound) -> none
    const row = await cdr.recordCall({
      callSid: 'CA3', direction: 'outbound', from: OTHER, to: '+15550001111', status: 'completed',
    });
    expect(row).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1); // only the lookup
  });

  it('returns null without touching the DB when callSid is missing', async () => {
    expect(await cdr.recordCall({ from: OUR_DID, to: OTHER })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('recordVoicemail', () => {
  it('inserts a message_type=voicemail inbound CDR with explicit account/tenant', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'mr-vm', message_type: 'voicemail' }] });
    const row = await cdr.recordVoicemail({
      messageId: 'vm-1',
      accountId: ACCOUNT_ID,
      tenantId: 'ten-1',
      from: OTHER,
      to: OUR_DID,
      createdAt: '2026-07-06T00:00:00.000Z',
    });
    expect(row).toMatchObject({ id: 'mr-vm', message_type: 'voicemail' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO message_records/);
    expect(sql).toMatch(/'inbound'.*'received'.*'voicemail'/s);
    expect(params).toEqual([ACCOUNT_ID, 'ten-1', 'vm-1', OTHER, OUR_DID, '2026-07-06T00:00:00.000Z']);
  });

  it('returns null without a messageId or accountId', async () => {
    expect(await cdr.recordVoicemail({ messageId: 'vm-1' })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('recordMessage', () => {
  it('inserts a new inbound message owned by the to-number account', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, tenant_id: 'ten-1' }] }) // lookup(to) for inbound
      .mockResolvedValueOnce({ rows: [] }) // UPDATE miss
      .mockResolvedValueOnce({ rows: [{ id: 'mr-1', direction: 'inbound', message_type: 'sms' }] });

    const row = await cdr.recordMessage({
      messageId: 'MSG1', direction: 'inbound', from: OTHER, to: OUR_DID, status: 'received',
    });

    expect(row).toMatchObject({ id: 'mr-1', message_type: 'sms' });
    expect(db.query.mock.calls[0][1]).toEqual([OUR_DID]);
    expect(db.query.mock.calls[2][1][3]).toBe('inbound');
  });

  it('upserts by message_id (status update) without inserting', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, tenant_id: 'ten-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'mr-1', status: 'delivered' }] }); // UPDATE hit

    const row = await cdr.recordMessage({
      messageId: 'MSG1', direction: 'outbound', from: OUR_DID, to: OTHER, status: 'delivered',
    });
    expect(row).toMatchObject({ status: 'delivered' });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('prefers an explicit accountId/tenantId and skips the ownership lookup', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE miss
      .mockResolvedValueOnce({ rows: [{ id: 'mr-9', direction: 'inbound' }] }); // INSERT
    await cdr.recordMessage({
      messageId: 'MSG9',
      direction: 'inbound',
      from: OTHER,
      to: OUR_DID,
      status: 'received',
      accountId: ACCOUNT_ID,
      tenantId: 'ten-9',
    });
    // No accountForNumber SELECT — first call is the UPDATE.
    expect(db.query.mock.calls[0][0]).toMatch(/UPDATE message_records/);
    // INSERT carries the explicit account_id + tenant_id.
    const insertParams = db.query.mock.calls[1][1];
    expect(insertParams[0]).toBe(ACCOUNT_ID);
    expect(insertParams[1]).toBe('ten-9');
  });

  it('backfills account_id/tenant_id on the status-update path', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'mr-1', status: 'delivered' }] }); // UPDATE hit
    await cdr.recordMessage({
      messageId: 'MSG1',
      direction: 'outbound',
      from: OUR_DID,
      to: OTHER,
      status: 'delivered',
      accountId: ACCOUNT_ID,
      tenantId: 'ten-1',
    });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/account_id = COALESCE\(account_id, \$2\)/);
    expect(sql).toMatch(/tenant_id = COALESCE\(tenant_id, \$3\)/);
    expect(params).toEqual(['delivered', ACCOUNT_ID, 'ten-1', 'MSG1']);
  });

  it('normalizes an unknown message_type to sms', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, tenant_id: 'ten-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'mr-2' }] });
    await cdr.recordMessage({
      messageId: 'MSG2', direction: 'outbound', from: OUR_DID, to: OTHER, status: 'sent', messageType: 'weird',
    });
    expect(db.query.mock.calls[2][1][7]).toBe('sms');
  });
});

describe('history queries', () => {
  it('getCallHistory clamps limit and applies offset, newest first', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'cr-1' }] });
    await cdr.getCallHistory(ACCOUNT_ID, { limit: '9999', offset: '10' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params).toEqual([ACCOUNT_ID, 200, 10]); // limit clamped to 200
  });

  it('getMessageHistory defaults limit/offset', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await cdr.getMessageHistory(ACCOUNT_ID, {});
    expect(db.query.mock.calls[0][1]).toEqual([ACCOUNT_ID, 50, 0]);
  });

  it('getAccountCdrs unions calls + messages', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ record_type: 'call' }, { record_type: 'message' }] });
    const rows = await cdr.getAccountCdrs(ACCOUNT_ID, { limit: 25 });
    expect(rows).toHaveLength(2);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UNION ALL/);
    expect(sql).toMatch(/call_records/);
    expect(sql).toMatch(/message_records/);
    expect(params).toEqual([ACCOUNT_ID, 25, 0]);
  });
});
