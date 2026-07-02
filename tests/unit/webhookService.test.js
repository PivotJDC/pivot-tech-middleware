jest.mock('../../src/db');
jest.mock('../../src/integrations/telnyx');
jest.mock('../../src/services/notificationService');
jest.mock('../../src/config', () => ({ signalwire: { webhookSecret: 'whsec' } }));

const crypto = require('crypto');
const db = require('../../src/db');
const telnyx = require('../../src/integrations/telnyx');
const notificationService = require('../../src/services/notificationService');
const webhookService = require('../../src/services/webhookService');

function hmac(body) {
  return crypto.createHmac('sha256', 'whsec').update(body).digest('hex');
}

/** Build a transaction client whose query() answers based on the SQL text. */
function clientFor(port, { campaign = { id: 'camp-int', signalwire_campaign_id: 'sw-camp' }, existingDid = null } = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (sql.includes('FROM port_requests') && sql.includes('FOR UPDATE')) return { rows: port ? [port] : [] };
      if (sql.includes('FROM accounts')) return { rows: [{ id: 'acc-1', market: 'lewiston-id' }] };
      if (sql.includes('FROM tcr_campaigns')) return { rows: campaign ? [campaign] : [] };
      if (sql.includes('FROM dids')) return { rows: existingDid ? [existingDid] : [] };
      return { rows: [] };
    }),
  };
}

const portRow = {
  id: 'p1',
  status: 'approved',
  account_id: 'acc-1',
  number_e164: '+12085550100',
  signalwire_port_id: 'swp1',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('verifySignature', () => {
  const body = Buffer.from(JSON.stringify({ a: 1 }));

  it('accepts a correct HMAC', () => {
    expect(webhookService.verifySignature(body, hmac(body))).toBe(true);
  });
  it('rejects a wrong or missing signature', () => {
    expect(webhookService.verifySignature(body, 'deadbeef')).toBe(false);
    expect(webhookService.verifySignature(body, undefined)).toBe(false);
  });
});

describe('handlePortEvent — validation', () => {
  it('ignores an unknown event type without a transaction', async () => {
    const res = await webhookService.handlePortEvent({ type: 'port.bogus', data: { port_id: 'x' } });
    expect(res).toEqual({ handled: false, reason: 'unknown_event_type' });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it('acks unknown ports', async () => {
    db.withTransaction.mockImplementationOnce(async (fn) => fn(clientFor(null)));
    const res = await webhookService.handlePortEvent({ type: 'port.submitted', data: { port_id: 'nope' } });
    expect(res).toMatchObject({ handled: false, reason: 'unknown_port' });
  });
});

describe('handlePortEvent — transitions', () => {
  it('marks a port submitted', async () => {
    const client = clientFor({ ...portRow, status: 'pending' });
    db.withTransaction.mockImplementationOnce(async (fn) => fn(client));
    const res = await webhookService.handlePortEvent({ type: 'port.submitted', data: { port_id: 'swp1' } });
    expect(res).toMatchObject({ handled: true, status: 'submitted' });
    expect(client.query.mock.calls.some((c) => /status = 'submitted'/.test(c[0]))).toBe(true);
  });

  it('completes a port: assigns campaign, upserts did, updates account, notifies', async () => {
    const client = clientFor(portRow); // status 'approved', no existing did
    db.withTransaction.mockImplementationOnce(async (fn) => fn(client));
    telnyx.assignNumberToCampaign.mockResolvedValueOnce({});
    notificationService.notify.mockResolvedValueOnce({});

    const res = await webhookService.handlePortEvent({
      type: 'port.completed',
      data: { port_id: 'swp1', number_sid: 'nsid' },
    });

    expect(res).toMatchObject({ handled: true, status: 'completed' });
    expect(telnyx.assignNumberToCampaign).toHaveBeenCalledWith('nsid', 'sw-camp');
    expect(client.query.mock.calls.some((c) => /INSERT INTO dids/.test(c[0]))).toBe(true);
    expect(client.query.mock.calls.some((c) => /UPDATE accounts SET phone_e164/.test(c[0]))).toBe(true);
    expect(notificationService.notify).toHaveBeenCalledWith({ id: 'acc-1' }, 'port.completed');
  });

  it('marks a port failed with a reason and notifies', async () => {
    const client = clientFor(portRow);
    db.withTransaction.mockImplementationOnce(async (fn) => fn(client));
    notificationService.notify.mockResolvedValueOnce({});

    const res = await webhookService.handlePortEvent({
      type: 'port.failed',
      data: { port_id: 'swp1', reason: 'carrier rejected' },
    });

    expect(res).toMatchObject({ handled: true, status: 'failed' });
    const failCall = client.query.mock.calls.find((c) => /status = 'failed'/.test(c[0]));
    expect(failCall[1]).toEqual(['p1', 'carrier rejected']);
    expect(notificationService.notify).toHaveBeenCalledWith({ id: 'acc-1' }, 'port.failed');
  });
});

describe('handlePortEvent — idempotency / ordering', () => {
  it('ignores events for an already-completed port (no side effects)', async () => {
    const client = clientFor({ ...portRow, status: 'completed' });
    db.withTransaction.mockImplementationOnce(async (fn) => fn(client));
    const res = await webhookService.handlePortEvent({
      type: 'port.completed', data: { port_id: 'swp1', number_sid: 'nsid' },
    });
    expect(res).toMatchObject({ handled: true, idempotent: true, status: 'completed' });
    expect(telnyx.assignNumberToCampaign).not.toHaveBeenCalled();
    expect(notificationService.notify).not.toHaveBeenCalled();
  });

  it('ignores a backwards event (submitted after approved)', async () => {
    const client = clientFor({ ...portRow, status: 'approved' });
    db.withTransaction.mockImplementationOnce(async (fn) => fn(client));
    const res = await webhookService.handlePortEvent({ type: 'port.submitted', data: { port_id: 'swp1' } });
    expect(res).toMatchObject({ handled: true, idempotent: true, status: 'approved' });
  });
});

describe('handleGeneralEvent', () => {
  it('acks general events', async () => {
    const res = await webhookService.handleGeneralEvent({ type: 'call.ended' });
    expect(res).toEqual({ handled: true });
  });
});
