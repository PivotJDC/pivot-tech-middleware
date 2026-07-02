jest.mock('../../src/db');
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {},
  },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const pushService = require('../../src/services/pushService');

beforeEach(() => {
  db.query.mockReset();
  global.fetch = jest.fn();
});
afterAll(() => {
  delete global.fetch;
});

describe('registerToken', () => {
  it('upserts on (account_id, selector) with both tokens + tenant', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pt-1' }] });
    const row = await pushService.registerToken('acc-1', 'ten-1', {
      selector: 'sel-abc',
      pushTokenCalls: 'voip-tok',
      pushTokenOther: 'msg-tok',
      pushAppIdCalls: 'io.pivot.calls',
      pushAppIdOther: 'io.pivot.other',
      deviceId: 'dev-1',
      platform: 'ios',
    });
    expect(row.id).toBe('pt-1');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO push_tokens/);
    expect(sql).toMatch(/ON CONFLICT \(account_id, selector\)/);
    expect(params).toEqual([
      'acc-1', 'ten-1', 'sel-abc', 'voip-tok', 'msg-tok',
      'io.pivot.calls', 'io.pivot.other', 'dev-1', 'ios',
    ]);
  });

  it('nulls out any missing optional token fields', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pt-2' }] });
    await pushService.registerToken('acc-1', 'ten-1', { selector: 'sel-x' });
    const [, params] = db.query.mock.calls[0];
    expect(params).toEqual(['acc-1', 'ten-1', 'sel-x', null, null, null, null, null, null]);
  });

  it('rejects when selector is missing', async () => {
    await expect(pushService.registerToken('acc-1', 'ten-1', { pushTokenOther: 't' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'selector' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects when tenant is missing', async () => {
    await expect(pushService.registerToken('acc-1', null, { selector: 'sel' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'tenant_id' });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('sendMessagePush', () => {
  it('posts a NotifyTextMessage to the PNM for each token using the "other" token', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { push_token_other: 't1', push_app_id_other: 'app1', selector: 's1' },
        { push_token_other: 't2', push_app_id_other: 'app2', selector: 's2' },
      ],
    });
    global.fetch.mockResolvedValue({ ok: true });

    const result = await pushService.sendMessagePush('acc-1', {
      from: '+12022762305', body: 'Hello', messageId: 'm1', streamId: '+12022762305',
    });
    expect(result).toEqual({ sent: 2 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://pnm.cloudsoftphone.com/pnm2/send');
    expect(JSON.parse(init.body)).toEqual({
      verb: 'NotifyTextMessage',
      AppId: 'app1',
      DeviceToken: 't1',
      Selector: 's1',
      Badge: 1,
      Sound: 'default',
      UserName: '+12022762305',
      Message: 'Hello',
      ContentType: 'text/plain',
      Id: 'm1',
      ThreadId: '+12022762305',
    });
  });

  it('truncates the message preview to 100 characters', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ push_token_other: 't1', push_app_id_other: 'app' }] });
    global.fetch.mockResolvedValue({ ok: true });
    await pushService.sendMessagePush('acc-1', { body: 'x'.repeat(250), messageId: 'm1' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.Message).toHaveLength(100);
  });

  it('is a no-op (and never throws) when there are no tokens', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await pushService.sendMessagePush('acc-1', { messageId: 'm1' })).toEqual({ sent: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('swallows a PNM failure and reports how many succeeded', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ push_token_other: 't1', push_app_id_other: 'app' }] });
    global.fetch.mockRejectedValueOnce(new Error('network down'));
    expect(await pushService.sendMessagePush('acc-1', { messageId: 'm1' })).toEqual({ sent: 0 });
  });

  it('swallows a DB lookup failure', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));
    expect(await pushService.sendMessagePush('acc-1', { messageId: 'm1' })).toEqual({ sent: 0 });
  });
});
