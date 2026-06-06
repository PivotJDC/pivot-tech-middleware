// Mock config: real credentials shape + tiny retry base so backoff is fast.
jest.mock('../../src/config', () => ({
  signalwire: {
    space: 'sw', projectId: 'pid', apiToken: 'tok', retryBaseMs: 1,
  },
  logLevel: 'silent',
  isProduction: true,
}));

const signalwire = require('../../src/integrations/signalwire');

function ok(body, status = 200) {
  return { ok: true, status, text: async () => JSON.stringify(body) };
}
function fail(status) {
  return { ok: false, status, text: async () => 'error body' };
}

beforeEach(() => {
  global.fetch = jest.fn();
});
afterAll(() => {
  delete global.fetch;
});

describe('request retry policy', () => {
  it('returns parsed body on first success with Basic auth', async () => {
    global.fetch.mockResolvedValueOnce(ok({ data: [{ number: '+12085550100' }] }));
    const result = await signalwire.searchAvailableNumbers('208');
    expect(result).toEqual([{ number: '+12085550100' }]);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('https://sw.signalwire.com/api/relay/rest/phone_numbers/search?areacode=208');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('pid:tok').toString('base64')}`);
  });

  it('retries on a network error then succeeds', async () => {
    global.fetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok({ data: [] }));
    const result = await signalwire.searchAvailableNumbers('208');
    expect(result).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx and gives up after 4 attempts (1 + 3 retries)', async () => {
    global.fetch.mockResolvedValue(fail(500));
    await expect(signalwire.searchAvailableNumbers('208'))
      .rejects.toMatchObject({ code: 'SIGNALWIRE_ERROR', status: 502 });
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry a 4xx client error', async () => {
    global.fetch.mockResolvedValue(fail(400));
    await expect(signalwire.purchaseNumber('+12085550100'))
      .rejects.toMatchObject({ code: 'SIGNALWIRE_ERROR' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('typed API calls', () => {
  it('purchaseNumber posts the number', async () => {
    global.fetch.mockResolvedValueOnce(ok({ id: 'sid-1' }));
    const res = await signalwire.purchaseNumber('+12085550100');
    expect(res).toEqual({ id: 'sid-1' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://sw.signalwire.com/api/relay/rest/phone_numbers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ number: '+12085550100' });
  });

  it('createSipEndpoint posts to /endpoints/sip with encryption + codecs', async () => {
    global.fetch.mockResolvedValueOnce(ok({ id: 'ep-1' }));
    await signalwire.createSipEndpoint({ username: 'u', password: 'p', callerId: '+12085550100' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://sw.signalwire.com/api/relay/rest/endpoints/sip');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      username: 'u',
      password: 'p',
      caller_id: '+12085550100',
      encryption: 'required',
      codecs: ['OPUS', 'PCMU'],
    });
  });

  it('assignNumberToEndpoint PUTs the endpoint id', async () => {
    global.fetch.mockResolvedValueOnce(ok({}));
    await signalwire.assignNumberToEndpoint('sid-1', 'ep-1');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://sw.signalwire.com/api/relay/rest/phone_numbers/sid-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ sip_endpoint_id: 'ep-1' });
  });

  it('updateSipEndpoint PUTs to /endpoints/sip/{id}', async () => {
    global.fetch.mockResolvedValueOnce(ok({ id: 'ep-1' }));
    await signalwire.updateSipEndpoint('ep-1', { password: 'rotated' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://sw.signalwire.com/api/relay/rest/endpoints/sip/ep-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ password: 'rotated' });
  });

  it('deleteSipEndpoint hits /endpoints/sip/{id} and returns null on 204', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' });
    const res = await signalwire.deleteSipEndpoint('ep-1');
    expect(res).toBeNull();
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://sw.signalwire.com/api/relay/rest/endpoints/sip/ep-1');
    expect(init.method).toBe('DELETE');
  });
});
