jest.mock('../../src/db');
jest.mock('../../src/integrations/telnyx');
jest.mock('../../src/integrations/s3');
// Keep the real media helpers but stub video thumbnail generation (no ffmpeg).
jest.mock('../../src/utils/media', () => ({
  ...jest.requireActual('../../src/utils/media'),
  generateVideoThumbnail: jest.fn(),
}));
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
const s3 = require('../../src/integrations/s3');
const accountService = require('../../src/services/accountService');
const cdrService = require('../../src/services/cdrService');
const pushService = require('../../src/services/pushService');
const media = require('../../src/utils/media');
const messaging = require('../../src/services/messagingService');

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  db.query.mockReset();
  telnyx.sendMessage.mockReset();
  telnyx.sendGroupMessage.mockReset();
  accountService.getAccountById.mockReset();
  accountService.lookupByPhoneE164.mockReset();
  cdrService.recordMessage.mockReset();
  pushService.sendMessagePush.mockReset();
  // Default: no S3 bucket → inbound media archival is skipped.
  s3.bucket.mockReset();
  s3.bucket.mockReturnValue('');
  s3.uploadObject.mockReset();
  s3.objectUrl.mockReset();
  s3.objectUrl.mockImplementation((key) => `https://bucket.s3.amazonaws.com/${key}`);
  global.fetch = jest.fn();
});
afterAll(() => {
  delete global.fetch;
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

describe('sendGroupMessage', () => {
  it('sends via the group endpoint and stores group_id + cc', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: ACCOUNT_ID, status: 'active', phone_e164: '+12085550100',
    });
    telnyx.sendGroupMessage.mockResolvedValueOnce({ id: 'tmsg-g1', group_message_id: 'gm-1' });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'mg1', group_id: 'gm-1' }] });

    const msg = await messaging.sendGroupMessage(ACCOUNT_ID, {
      to: ['+12085550142', '+12085550143'], body: 'hey team', mediaUrls: [],
    });

    expect(telnyx.sendGroupMessage).toHaveBeenCalledWith({
      from: '+12085550100', to: ['+12085550142', '+12085550143'], body: 'hey team', mediaUrls: [],
    });
    expect(telnyx.sendMessage).not.toHaveBeenCalled();
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO messages/);
    expect(sql).toMatch(/group_id, cc/);
    expect(params[2]).toBe('+12085550142'); // to_number = first recipient
    expect(params[5]).toBe('tmsg-g1'); // telnyx_message_id
    expect(params[6]).toBe('gm-1'); // group_id (group_message_id)
    expect(params[7]).toEqual(['+12085550142', '+12085550143']); // cc
    expect(msg.id).toBe('mg1');
  });

  it('falls back to the message id when no group_message_id is returned', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: ACCOUNT_ID, status: 'active', phone_e164: '+12085550100',
    });
    telnyx.sendGroupMessage.mockResolvedValueOnce({ id: 'tmsg-g2' });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'mg2' }] });

    await messaging.sendGroupMessage(ACCOUNT_ID, {
      to: ['+12085550142', '+12085550143'], body: 'hi',
    });
    expect(db.query.mock.calls[0][1][6]).toBe('tmsg-g2'); // group_id falls back to id
  });

  it('rejects a group with fewer than two recipients', async () => {
    accountService.getAccountById.mockResolvedValueOnce({
      id: ACCOUNT_ID, status: 'active', phone_e164: '+12085550100',
    });
    await expect(messaging.sendGroupMessage(ACCOUNT_ID, { to: ['+12085550142'], body: 'hi' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'to' });
    expect(telnyx.sendGroupMessage).not.toHaveBeenCalled();
  });
});

describe('handleInboundMessage', () => {
  it('creates an inbound record from a Telnyx payload', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] }) // account by `to`
      .mockResolvedValueOnce({ rows: [] }) // idempotency: no existing message
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

    const [sql, params] = db.query.mock.calls[2];
    expect(sql).toMatch(/'inbound'/);
    expect(params[0]).toBe(ACCOUNT_ID);
    expect(params[1]).toBe('+12085550142'); // from
    expect(params[2]).toBe('+12085550100'); // to
    expect(params[3]).toBe('hi there'); // body
    expect(params[4]).toEqual(['https://x/a.jpg']); // media
    expect(params[5]).toBe('tmsg-in-1');
    expect(msg.id).toBe('in-1');
  });

  it('stores group_id + cc for an inbound group message (cc present)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] }) // account by `to`
      .mockResolvedValueOnce({ rows: [] }) // idempotency: no existing message
      .mockResolvedValueOnce({ rows: [{ id: 'in-g', direction: 'inbound', group_id: 'gm-7' }] });

    const msg = await messaging.handleInboundMessage({
      id: 'tmsg-in-g',
      group_message_id: 'gm-7',
      from: { phone_number: '+12085550142' },
      to: [{ phone_number: '+12085550100' }],
      cc: [{ phone_number: '+12085550143' }, '+12085550144'], // mixed object/string
      text: 'group hi',
    });

    const [sql, params] = db.query.mock.calls[2];
    expect(sql).toMatch(/group_id, cc/);
    expect(params[6]).toBe('gm-7'); // group_id from group_message_id
    expect(params[7]).toEqual(['+12085550143', '+12085550144']); // cc normalized
    expect(msg.id).toBe('in-g');
    // Push threads by the group id, not the sender.
    expect(pushService.sendMessagePush).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ streamId: 'gm-7' }),
    );
  });

  it('leaves group_id null and cc empty for a 1:1 inbound message (no cc)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'in-solo', direction: 'inbound' }] });

    await messaging.handleInboundMessage({
      id: 'tmsg-solo',
      from: { phone_number: '+12085550142' },
      to: [{ phone_number: '+12085550100' }],
      text: 'just you',
    });
    const params = db.query.mock.calls[2][1];
    expect(params[6]).toBeNull(); // group_id
    expect(params[7]).toEqual([]); // cc
  });

  it('ignores an inbound message for an unknown number', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no account
    const result = await messaging.handleInboundMessage({
      from: { phone_number: '+1' }, to: [{ phone_number: '+19999999999' }], text: 'x',
    });
    expect(result).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1); // no INSERT
  });

  it('skips a duplicate webhook (same telnyx_message_id) and returns the existing row', async () => {
    const existing = { id: 'in-dup', direction: 'inbound', from_number: '+12085550142' };
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] }) // account by `to`
      .mockResolvedValueOnce({ rows: [existing] }); // idempotency: already stored

    const msg = await messaging.handleInboundMessage({
      id: 'tmsg-dup',
      from: { phone_number: '+12085550142' },
      to: [{ phone_number: '+12085550100' }],
      text: 'hi',
    });

    expect(msg).toEqual(existing);
    // Looked up by telnyx_message_id; no INSERT, no push.
    const dedup = db.query.mock.calls[1];
    expect(dedup[0]).toMatch(/SELECT \* FROM messages WHERE telnyx_message_id = \$1/);
    expect(dedup[1]).toEqual(['tmsg-dup']);
    expect(db.query).toHaveBeenCalledTimes(2); // account lookup + dedup only
    expect(pushService.sendMessagePush).not.toHaveBeenCalled();
  });

  it('gracefully returns the existing row when the INSERT hits a unique conflict (race)', async () => {
    const existing = { id: 'in-race', direction: 'inbound' };
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] }) // account by `to`
      .mockResolvedValueOnce({ rows: [] }) // pre-insert dedup: not found (race window)
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT DO NOTHING → no row
      .mockResolvedValueOnce({ rows: [existing] }); // SELECT existing after conflict

    const msg = await messaging.handleInboundMessage({
      id: 'tmsg-race',
      from: { phone_number: '+12085550142' },
      to: [{ phone_number: '+12085550100' }],
      text: 'hi',
    });

    expect(msg).toEqual(existing);
    // The INSERT uses ON CONFLICT DO NOTHING (partial-index predicate), then
    // re-selects the winner; no error, no push.
    expect(db.query.mock.calls[2][0])
      .toMatch(/ON CONFLICT \(telnyx_message_id\) WHERE telnyx_message_id IS NOT NULL DO NOTHING/);
    expect(db.query.mock.calls[3][0]).toMatch(/SELECT \* FROM messages WHERE telnyx_message_id = \$1/);
    expect(pushService.sendMessagePush).not.toHaveBeenCalled();
  });

  it('archives inbound media to S3 and rewrites media_urls (bucket set)', async () => {
    s3.bucket.mockReturnValue('mobilitynet-recordings');
    s3.uploadObject.mockResolvedValue({ key: 'k' });
    global.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new Uint8Array([9, 9]).buffer,
    });
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] }) // account by `to`
      .mockResolvedValueOnce({ rows: [] }) // idempotency: no existing message
      .mockResolvedValueOnce({ rows: [{ id: 'in-9', media_urls: ['https://telnyx/a.jpg'] }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // UPDATE media_urls

    const s3Url = `https://bucket.s3.amazonaws.com/mms-inbound/${ACCOUNT_ID}/in-9_0.jpg`;
    const msg = await messaging.handleInboundMessage({
      id: 't-9',
      from: { phone_number: '+12085550142' },
      to: [{ phone_number: '+12085550100' }],
      text: '',
      media: [{ url: 'https://telnyx/a.jpg', content_type: 'image/jpeg' }],
    });

    const update = db.query.mock.calls[3];
    expect(update[0]).toMatch(/UPDATE messages SET media_urls = \$1 WHERE id = \$2/);
    expect(update[1]).toEqual([[s3Url], 'in-9']);
    expect(msg.media_urls).toEqual([s3Url]);
  });
});

describe('archiveInboundMedia', () => {
  beforeEach(() => {
    s3.bucket.mockReturnValue('mobilitynet-recordings');
    s3.uploadObject.mockResolvedValue({ key: 'k' });
  });

  it('uploads each item under mms-inbound/{acct}/{msg}_{i}.{ext} and returns S3 URLs', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    const urls = await messaging.archiveInboundMedia('acc-1', 'msg-9', [
      { url: 'https://telnyx/a.jpg', content_type: 'image/jpeg' },
      { url: 'https://telnyx/b.png', content_type: 'image/png' },
    ]);
    expect(s3.uploadObject).toHaveBeenCalledTimes(2);
    expect(s3.uploadObject.mock.calls[0][0]).toMatchObject({
      key: 'mms-inbound/acc-1/msg-9_0.jpg', contentType: 'image/jpeg',
    });
    expect(s3.uploadObject.mock.calls[1][0].key).toBe('mms-inbound/acc-1/msg-9_1.png');
    expect(urls).toEqual([
      'https://bucket.s3.amazonaws.com/mms-inbound/acc-1/msg-9_0.jpg',
      'https://bucket.s3.amazonaws.com/mms-inbound/acc-1/msg-9_1.png',
    ]);
  });

  it('keeps the original Telnyx URL when an item fails to download', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const urls = await messaging.archiveInboundMedia('acc-1', 'msg-1', [
      { url: 'https://telnyx/x.jpg', content_type: 'image/jpeg' },
    ]);
    expect(urls).toEqual(['https://telnyx/x.jpg']);
    expect(s3.uploadObject).not.toHaveBeenCalled();
  });

  it('stores a video thumbnail alongside an inbound video ({key}_thumb.jpg)', async () => {
    media.generateVideoThumbnail.mockResolvedValueOnce(Buffer.from('thumb-bytes'));
    global.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'video/mp4' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    await messaging.archiveInboundMedia('acc-1', 'msg-7', [
      { url: 'https://telnyx/clip.mp4', content_type: 'video/mp4' },
    ]);

    const keys = s3.uploadObject.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual([
      'mms-inbound/acc-1/msg-7_0.mp4',
      'mms-inbound/acc-1/msg-7_0.mp4_thumb.jpg',
    ]);
    const thumb = s3.uploadObject.mock.calls.find((c) => c[0].key.endsWith('_thumb.jpg'));
    expect(thumb[0].contentType).toBe('image/jpeg');
    // The base64 thumbnail is cached on the row so /fetch never re-reads S3.
    const upd = db.query.mock.calls.find((c) => /video_thumbnail_base64/.test(c[0]));
    expect(upd[1]).toEqual([Buffer.from('thumb-bytes').toString('base64'), 'msg-7']);
  });
});

describe('cacheVideoThumbnail', () => {
  it('updates the message row with the base64 thumbnail', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    await messaging.cacheVideoThumbnail('msg-42', 'BASE64DATA');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE messages SET video_thumbnail_base64 = \$1 WHERE id = \$2/);
    expect(params).toEqual(['BASE64DATA', 'msg-42']);
  });

  it('is a no-op when the id or base64 is missing', async () => {
    await messaging.cacheVideoThumbnail('', 'x');
    await messaging.cacheVideoThumbnail('msg-1', '');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('swallows a DB error (best-effort)', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));
    await expect(messaging.cacheVideoThumbnail('msg-9', 'b64')).resolves.toBeUndefined();
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

  it('pushes an inbound message to the account, threaded by sender', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] }) // account lookup by `to`
      .mockResolvedValueOnce({ rows: [] }) // idempotency: no existing message
      .mockResolvedValueOnce({ // inbound insert RETURNING *
        rows: [{
          id: 'in-9', from_number: '+12022762305', to_number: '+12085550100', body: 'Hello there',
        }],
      });
    await messaging.handleMessagingWebhook({
      data: {
        event_type: 'message.received',
        payload: {
          id: 't9',
          from: { phone_number: '+12022762305' },
          to: [{ phone_number: '+12085550100' }],
          text: 'Hello there',
        },
      },
    });
    expect(pushService.sendMessagePush).toHaveBeenCalledWith(ACCOUNT_ID, {
      from: '+12022762305',
      body: 'Hello there',
      messageId: 'in-9',
      streamId: '+12022762305',
    });
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

  it('tags the CDR with the owning account + tenant looked up by number', async () => {
    // Outbound: the subscriber's number is `from`.
    accountService.lookupByPhoneE164.mockResolvedValueOnce({ id: ACCOUNT_ID, tenant_id: 'ten-7' });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'm1', status: 'delivered' }] });
    await messaging.handleMessagingWebhook({
      data: {
        event_type: 'message.delivered',
        payload: {
          id: 'tmsg-9',
          direction: 'outbound',
          from: { phone_number: '+12085550100' },
          to: [{ phone_number: '+12085550142' }],
        },
      },
    });
    expect(accountService.lookupByPhoneE164).toHaveBeenCalledWith('+12085550100');
    expect(cdrService.recordMessage).toHaveBeenCalledWith(expect.objectContaining({
      accountId: ACCOUNT_ID,
      tenantId: 'ten-7',
    }));
  });

  it('looks up the subscriber by the to-number for inbound events', async () => {
    accountService.lookupByPhoneE164.mockResolvedValueOnce({ id: ACCOUNT_ID, tenant_id: 'ten-8' });
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] }) // handleInboundMessage lookup
      .mockResolvedValueOnce({ rows: [{ id: 'in-2' }] }); // inbound insert
    await messaging.handleMessagingWebhook({
      data: {
        event_type: 'message.received',
        payload: {
          id: 'tmsg-10',
          direction: 'inbound',
          from: { phone_number: '+12085550142' },
          to: [{ phone_number: '+12085550100' }],
          text: 'hi',
        },
      },
    });
    // Inbound: subscriber number is the `to` (our DID).
    expect(accountService.lookupByPhoneE164).toHaveBeenCalledWith('+12085550100');
    expect(cdrService.recordMessage).toHaveBeenCalledWith(expect.objectContaining({
      accountId: ACCOUNT_ID,
      tenantId: 'ten-8',
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

describe('recordInboundMessage', () => {
  it('inserts an inbound row into messages (voicemail delivery)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'msg-vm' }] });
    const row = await messaging.recordInboundMessage({
      accountId: 'acc-1',
      from: '+12022762305',
      to: '+12085550100',
      body: '🎙️ Voicemail (12s): hi',
      createdAt: '2026-07-06T00:00:00.000Z',
    });
    expect(row).toEqual({ id: 'msg-vm' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO messages/);
    expect(sql).toMatch(/direction, from_number, to_number, body, status, created_at/);
    expect(sql).toMatch(/COALESCE\(\$5, NOW\(\)\)/);
    expect(params).toEqual([
      'acc-1', '+12022762305', '+12085550100', '🎙️ Voicemail (12s): hi', '2026-07-06T00:00:00.000Z',
    ]);
  });
});
