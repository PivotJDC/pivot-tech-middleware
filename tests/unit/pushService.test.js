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
  it('upserts on (account_id, device_id)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pt-1' }] });
    const row = await pushService.registerToken('acc-1', {
      deviceToken: 'tok', selector: 'sel', appId: 'app', platform: 'ios', deviceId: 'dev-1',
    });
    expect(row.id).toBe('pt-1');
    const [sql, escapedParams] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO push_tokens/);
    expect(sql).toMatch(/ON CONFLICT \(account_id, device_id\)/);
    expect(escapedParams).toEqual(['acc-1', 'tok', 'sel', 'app', 'ios', 'dev-1']);
  });

  it('rejects when device_token is missing', async () => {
    await expect(pushService.registerToken('acc-1', { appId: 'a', platform: 'ios' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'device_token' });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('sendMessageNotification', () => {
  it('posts to the Acrobits PNM for each registered token', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { device_token: 't1', selector: 's1', app_id: 'app' },
        { device_token: 't2', selector: 's2', app_id: 'app' },
      ],
    });
    global.fetch.mockResolvedValue({ ok: true });

    const result = await pushService.sendMessageNotification('acc-1', { id: 'm1' });
    expect(result).toEqual({ sent: 2 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://pnm.cloudsoftphone.com/pnm2/send');
    expect(JSON.parse(init.body)).toEqual({
      DeviceToken: 't1', Selector: 's1', AppId: 'app', verb: 'NotifyTextMessage',
    });
  });

  it('is a no-op (and never throws) when there are no tokens', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await pushService.sendMessageNotification('acc-1', { id: 'm1' })).toEqual({ sent: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('swallows a PNM failure and reports how many succeeded', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ device_token: 't1', app_id: 'app' }] });
    global.fetch.mockRejectedValueOnce(new Error('network down'));
    expect(await pushService.sendMessageNotification('acc-1', { id: 'm1' })).toEqual({ sent: 0 });
  });
});
