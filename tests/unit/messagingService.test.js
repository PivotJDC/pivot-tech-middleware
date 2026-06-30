jest.mock('../../src/db');
jest.mock('../../src/integrations/telnyx');
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/pushService');
jest.mock('../../src/services/cdrService');
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {},
  },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const telnyx = require('../../src/integrations/telnyx');
const accountService = require('../../src/services/accountService');
const cdrService = require('../../src/services/cdrService');
const messaging = require('../../src/services/messagingService');

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  db.query.mockReset();
  telnyx.sendMessage.mockReset();
  accountService.getAccountById.mockReset();
  cdrService.recordMessage.mockReset();
});

describe('sendMessage', () => {
  it('creates an outbound record and calls telnyx with the account number', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: ACCOUNT_ID, status: 'active', phone_e164: '+12085550100',
    });
    telnyx.sendMessage.mockResolvedValueOnce({ id: 'tmsg-1', status: 'queued' });
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'm1', direction: 'outbound', telnyx_message_id: 'tmsg-1' }],
    });

    const msg = await messaging.sendMessage(ACCOUNT_ID, {
      to: '+12085550142', body: 'Hello', mediaUrls: [],
    });

    expect(telnyx.sendMessage).toHaveBeenCalledWith({
      from: '+12085550100', to: '+12085550142', body: 'Hello', mediaUrls: [],
    });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO messages/);
    expect(sql).toMatch(/'outbound'/);
    // (account_id, from, to, body, media_urls, telnyx_id, status)
    expect(params[0]).toBe(ACCOUNT_ID);
    expect(params[1]).toBe('+12085550100');
    expect(params[2]).toBe('+12085550142');
    expect(params[5]).toBe('tmsg-1');
    expect(msg.id).toBe('m1');
  });

  it('rejects when the account is not active', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: ACCOUNT_ID, status: 'suspended', phone_e164: '+12085550100',
    });
    await expect(messaging.sendMessage(ACCOUNT_ID, { to: '+12085550142', body: 'Hi' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'status' });
    expect(telnyx.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects when neither body nor media is provided', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: ACCOUNT_ID, status: 'active', phone_e164: '+12085550100',
    });
    await expect(messaging.sendMessage(ACCOUNT_ID, { to: '+12085550142' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'body' });
    expect(telnyx.sendMessage).not.toHaveBeenCalled();
  });

  it('sends an MMS (media only, empty body)', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: ACCOUNT_ID, status: 'active', phone_e164: '+12085550100',
    });
    telnyx.sendMessage.mockResolvedValueOnce({ id: 'tmsg-2' });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'm2' }] });

    await messaging.sendMessage(ACCOUNT_ID, {
      to: '+12085550142', mediaUrls: ['https://x/img.jpg'],
    });
    expect(telnyx.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrls: ['https://x/img.jpg'], body: '' }),
    );
  });
});

describe('handleInboundMessage', () => {
  it('creates an inbound record from a Telnyx payload', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] }) // account by `to`
      .mockResolvedValueOnce({ rows: [{ id: 'in-1', direction: 'inbound' }] }); // INSERT

    const payload = {
      id: 'tmsg-in-1',
      from: { phone_number: '+12085550142' },
      to: [{ phone_number: '+12085550100' }],
      text: 'hi there',
      media: [{ url: 'https://x/a.jpg' }],
    };
    const msg = await messaging.handleInboundMessage(payload);

    const lookup = db.query.mock.calls[0];
    expect(lookup[0]).toMatch(/WHERE phone_e164 = \$1/);
    expect(lookup[1]).toEqual(['+12085550100']);

    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/'inbound'/);
    expect(params[0]).toBe(ACCOUNT_ID);
    expect(params[1]).toBe('+12085550142'); // from
    expect(params[2]).toBe('+12085550100'); // to
    expect(params[3]).toBe('hi there'); // body
    expect(params[4]).toEqual(['https://x/a.jpg']); // media
    expect(params[5]).toBe('tmsg-in-1');
    expect(msg.id).toBe('in-1');
  });

  it('ignores an inbound message for an unknown number', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no account
    const result = await messaging.handleInboundMessage({
      from: { phone_number: '+1' }, to: [{ phone_number: '+19999999999' }], text: 'x',
    });
    expect(result).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1); // no INSERT
  });
});

describe('getMessages', () => {
  it('returns rows ordered newest-first with the default limit', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] });
    const rows = await messaging.getMessages(ACCOUNT_ID, {});
    expect(rows).toHaveLength(2);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params).toEqual([ACCOUNT_ID, 50]);
  });

  it('applies a before cursor and a custom limit', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await messaging.getMessages(ACCOUNT_ID, { limit: '10', before: '2026-06-01T00:00:00Z' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/created_at < \$2/);
    expect(params).toEqual([ACCOUNT_ID, '2026-06-01T00:00:00Z', 10]);
  });
});

describe('getConversation', () => {
  it('filters by the other number on either side of the thread', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'c1' }] });
    await messaging.getConversation(ACCOUNT_ID, '+12085550142', {});
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/from_number = \$2 OR to_number = \$2/);
    expect(params).toEqual([ACCOUNT_ID, '+12085550142', 50]);
  });
});

describe('updateMessageStatus', () => {
  it('updates status + error keyed by telnyx message id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'm1', status: 'delivered' }] });
    const row = await messaging.updateMessageStatus('tmsg-1', 'delivered');
    expect(row.status).toBe('delivered');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE messages/);
    expect(params).toEqual(['delivered', null, 'tmsg-1']);
  });

  it('returns null when no message matches', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await messaging.updateMessageStatus('nope', 'sent')).toBeNull();
  });

  it('returns null without querying when the id is missing', async () => {
    expect(await messaging.updateMessageStatus(null, 'sent')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('handleMessagingWebhook', () => {
  it('routes message.received to an inbound insert', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: 'in-1' }] });
    const res = await messaging.handleMessagingWebhook({
      data: {
        event_type: 'message.received',
        payload: {
          id: 't1', from: { phone_number: '+1' }, to: [{ phone_number: '+12085550100' }], text: 'hi',
        },
      },
    });
    expect(res.handled).toBe('message.received');
  });

  it('routes message.delivered to a status update', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'm1', status: 'delivered' }] });
    const res = await messaging.handleMessagingWebhook({
      data: { event_type: 'message.delivered', payload: { id: 'tmsg-1' } },
    });
    expect(res.handled).toBe('message.delivered');
    expect(db.query.mock.calls[0][1]).toEqual(['delivered', null, 'tmsg-1']);
  });

  it('routes message.sending_failed and records the error detail', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'm1', status: 'failed' }] });
    await messaging.handleMessagingWebhook({
      data: {
        event_type: 'message.sending_failed',
        payload: { id: 'tmsg-1', errors: [{ detail: 'carrier rejected' }] },
      },
    });
    expect(db.query.mock.calls[0][1]).toEqual(['failed', 'carrier rejected', 'tmsg-1']);
  });

  it('ignores unknown event types', async () => {
    const res = await messaging.handleMessagingWebhook({
      data: { event_type: 'message.unknown', payload: {} },
    });
    expect(res.ignored).toBe('message.unknown');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('records a CDR (best-effort) for a known event with the mapped status', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'm1', status: 'delivered' }] });
    await messaging.handleMessagingWebhook({
      data: {
        event_type: 'message.delivered',
        payload: {
          id: 'tmsg-1',
          direction: 'outbound',
          from: { phone_number: '+12085550100' },
          to: [{ phone_number: '+12085550142' }],
          type: 'SMS',
        },
      },
    });
    expect(cdrService.recordMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'tmsg-1',
      direction: 'outbound',
      from: '+12085550100',
      to: '+12085550142',
      status: 'delivered',
      messageType: 'sms',
    }));
  });

  it('does not break handling when the CDR write throws', async () => {
    cdrService.recordMessage.mockRejectedValueOnce(new Error('db down'));
    db.query.mockResolvedValueOnce({ rows: [{ id: 'm1' }] });
    const res = await messaging.handleMessagingWebhook({
      data: { event_type: 'message.delivered', payload: { id: 'tmsg-2' } },
    });
    expect(res.handled).toBe('message.delivered');
  });
});
