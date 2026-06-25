// Mock config: Telnyx credentials shape + tiny retry base so backoff is fast.
jest.mock('../../src/config', () => ({
  telnyx: {
    apiKey: 'tok',
    sipConnectionId: 'conn-1',
    messagingProfileId: 'mp-1',
    retryBaseMs: 1,
  },
  logLevel: 'silent',
  isProduction: true,
}));

const telnyx = require('../../src/integrations/telnyx');

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
  it('returns parsed body on first success with Bearer auth', async () => {
    global.fetch.mockResolvedValueOnce(ok({ data: [{ phone_number: '+12085550100' }] }));
    const result = await telnyx.searchAvailableNumbers('208');
    // phone_number is normalized to `number` for the layers above.
    expect(result).toEqual([{ phone_number: '+12085550100', number: '+12085550100' }]);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('https://api.telnyx.com/v2/available_phone_numbers?');
    expect(decodeURIComponent(url)).toContain('filter[national_destination_code]=208');
    expect(decodeURIComponent(url)).toContain('filter[country_code]=US');
    expect(decodeURIComponent(url)).toContain('filter[features][]=sms');
    expect(decodeURIComponent(url)).toContain('filter[features][]=voice');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('retries on a network error then succeeds', async () => {
    global.fetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok({ data: [] }));
    const result = await telnyx.searchAvailableNumbers('208');
    expect(result).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx and gives up after 4 attempts (1 + 3 retries)', async () => {
    global.fetch.mockResolvedValue(fail(500));
    await expect(telnyx.searchAvailableNumbers('208'))
      .rejects.toMatchObject({ code: 'TELNYX_ERROR', status: 502 });
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry a 4xx client error', async () => {
    global.fetch.mockResolvedValue(fail(400));
    await expect(telnyx.purchaseNumber('+12085550100'))
      .rejects.toMatchObject({ code: 'TELNYX_ERROR' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('typed API calls', () => {
  it('purchaseNumber posts a number order and uses the E.164 as the id (not the order-line id)', async () => {
    global.fetch.mockResolvedValueOnce(ok({
      data: { id: 'order-1', phone_numbers: [{ id: 'pn-line-1', phone_number: '+12085550100' }] },
    }));
    const res = await telnyx.purchaseNumber('+12085550100');
    // The order-line id ('pn-line-1') and order id ('order-1') 404 on
    // /phone_numbers/{id}; the E.164 number is the correct path identifier.
    expect(res.id).toBe('+12085550100');
    expect(res.number).toBe('+12085550100');

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/number_orders');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ phone_numbers: [{ phone_number: '+12085550100' }] });
  });

  it('provisionPhoneNumber purchases then assigns the TeXML voice connection + messaging profile', async () => {
    global.fetch
      .mockResolvedValueOnce(ok({
        data: { id: 'order-1', phone_numbers: [{ phone_number: '+12085550100' }] },
      })) // purchase
      .mockResolvedValueOnce(ok({ data: {} })) // PATCH /voice
      .mockResolvedValueOnce(ok({ data: {} })); // PATCH /messaging

    const res = await telnyx.provisionPhoneNumber('+12085550100');
    expect(res.id).toBe('+12085550100');

    const { calls } = global.fetch.mock;
    expect(calls[0][0]).toBe('https://api.telnyx.com/v2/number_orders');

    // Voice → TeXML application connection.
    expect(calls[1][0]).toBe('https://api.telnyx.com/v2/phone_numbers/+12085550100/voice');
    expect(calls[1][1].method).toBe('PATCH');
    expect(JSON.parse(calls[1][1].body)).toEqual({ connection_id: '2990188126548264846' });

    // Messaging → messaging profile (from config in tests: 'mp-1').
    expect(calls[2][0]).toBe('https://api.telnyx.com/v2/phone_numbers/+12085550100/messaging');
    expect(calls[2][1].method).toBe('PATCH');
    expect(JSON.parse(calls[2][1].body)).toEqual({ messaging_profile_id: 'mp-1' });
  });

  it('assignNumberToEndpoint PATCHes /phone_numbers/{e164} with the literal + (no encoding)', async () => {
    global.fetch.mockResolvedValueOnce(ok({ data: {} }));
    await telnyx.assignNumberToEndpoint('+12085550100', 'cred-1');
    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/phone_numbers/+12085550100');
  });

  it('createSipEndpoint posts telephony_credentials with connection_id + name', async () => {
    global.fetch.mockResolvedValueOnce(ok({
      data: { id: 'cred-1', sip_username: 'u', sip_password: 'p' },
    }));
    const res = await telnyx.createSipEndpoint({ username: 'pivottech-x', password: 'ignored', callerId: '+12085550100' });
    expect(res).toEqual({ id: 'cred-1', sip_username: 'u', sip_password: 'p' });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/telephony_credentials');
    expect(init.method).toBe('POST');
    // Telnyx auto-generates credentials; only connection_id + name are sent.
    expect(JSON.parse(init.body)).toEqual({ connection_id: 'conn-1', name: 'pivottech-x' });
  });

  it('assignNumberToEndpoint PATCHes /phone_numbers/{id} with connection_id', async () => {
    global.fetch.mockResolvedValueOnce(ok({ data: {} }));
    await telnyx.assignNumberToEndpoint('pn-1', 'cred-1');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/phone_numbers/pn-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ connection_id: 'conn-1' });
  });

  it('getSipEndpoint GETs /telephony_credentials/{id} and returns the live credential', async () => {
    global.fetch.mockResolvedValueOnce(ok({
      data: { id: 'cred-1', sip_username: 'u', sip_password: 'live-pw' },
    }));
    const res = await telnyx.getSipEndpoint('cred-1');
    expect(res).toEqual({ id: 'cred-1', sip_username: 'u', sip_password: 'live-pw' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/telephony_credentials/cred-1');
    expect(init.method).toBe('GET');
  });

  it('updateSipEndpoint PATCHes /telephony_credentials/{id}', async () => {
    global.fetch.mockResolvedValueOnce(ok({ data: { id: 'cred-1' } }));
    await telnyx.updateSipEndpoint('cred-1', { name: 'renamed' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/telephony_credentials/cred-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'renamed' });
  });

  it('deleteSipEndpoint hits /telephony_credentials/{id} and returns null on 204', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' });
    const res = await telnyx.deleteSipEndpoint('cred-1');
    expect(res).toBeNull();
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/telephony_credentials/cred-1');
    expect(init.method).toBe('DELETE');
  });

  it('sendSms posts to /messages with the messaging profile id', async () => {
    global.fetch.mockResolvedValueOnce(ok({ data: { id: 'msg-1' } }));
    await telnyx.sendSms({ from: '+12085550100', to: '+12085550142', text: 'hi' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      from: '+12085550100',
      to: '+12085550142',
      text: 'hi',
      messaging_profile_id: 'mp-1',
    });
  });
});
