// Mock config: Telnyx credentials shape + tiny retry base so backoff is fast.
jest.mock('../../src/config', () => ({
  telnyx: {
    apiKey: 'tok',
    sipConnectionId: 'conn-1',
    messagingProfileId: 'mp-1',
    retryBaseMs: 1,
    messagingReadyDelayMs: 0,
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
  it('getCallRecordings first tries the call_session_id recordings filter', async () => {
    global.fetch.mockResolvedValueOnce(ok({
      data: [{ id: 'REC1', download_urls: { wav: 'https://telnyx/rec.wav' } }],
    }));
    const recs = await telnyx.getCallRecordings('v3:abc');
    expect(recs).toEqual([{ id: 'REC1', download_urls: { wav: 'https://telnyx/rec.wav' } }]);
    // First (and only) attempt: /recordings?filter[call_session_id]=v3:abc.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(decodeURIComponent(url))
      .toBe('https://api.telnyx.com/v2/recordings?filter[call_session_id]=v3:abc');
    expect(init.method).toBe('GET');
  });

  it('getCallRecordings falls back to call_leg_id, then the v3-stripped direct path', async () => {
    global.fetch
      .mockResolvedValueOnce(ok({ data: [] })) // call_session_id → empty
      .mockResolvedValueOnce(ok({ data: [] })) // call_leg_id → empty
      .mockResolvedValueOnce(ok({ data: [{ id: 'REC9' }] })); // direct path → hit
    const recs = await telnyx.getCallRecordings('v3:xyz');
    expect(recs).toEqual([{ id: 'REC9' }]);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(decodeURIComponent(global.fetch.mock.calls[1][0]))
      .toBe('https://api.telnyx.com/v2/recordings?filter[call_leg_id]=v3:xyz');
    // "v3:" is stripped from the direct path (the colon 404s when encoded).
    expect(global.fetch.mock.calls[2][0])
      .toBe('https://api.telnyx.com/v2/calls/xyz/recordings');
  });

  it('getCallRecordings tries the next approach when one attempt errors', async () => {
    global.fetch
      .mockResolvedValueOnce(fail(404)) // call_session_id → 404, not retried, falls through
      .mockResolvedValueOnce(ok({ data: [{ id: 'REC2' }] })); // call_leg_id → hit
    const recs = await telnyx.getCallRecordings('v3:abc');
    expect(recs).toEqual([{ id: 'REC2' }]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('getCallRecordings returns [] when every approach yields nothing', async () => {
    global.fetch.mockResolvedValue(ok({ data: [] }));
    expect(await telnyx.getCallRecordings('v3:none')).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

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

  it('provisionPhoneNumber resolves the numeric resource id and PATCHes voice + messaging on it', async () => {
    global.fetch
      .mockResolvedValueOnce(ok({
        data: { id: 'order-1', phone_numbers: [{ id: 'order-line-1', phone_number: '+12085550100' }] },
      })) // purchase (number order — order-line id, NOT usable on /phone_numbers)
      .mockResolvedValueOnce(ok({
        data: [{ id: '2990277475533063368', phone_number: '+12085550100' }],
      })) // GET /phone_numbers?filter -> numeric resource id
      .mockResolvedValueOnce(ok({ data: {} })) // PATCH /voice
      .mockResolvedValueOnce(ok({ data: {} })); // PATCH /messaging

    const res = await telnyx.provisionPhoneNumber('+12085550100');
    // Downstream (signalwire_sid, enableE911) needs the numeric resource id.
    expect(res.id).toBe('2990277475533063368');
    expect(res.number).toBe('+12085550100');

    const { calls } = global.fetch.mock;
    expect(calls[0][0]).toBe('https://api.telnyx.com/v2/number_orders');

    // Lookup by E.164 to get the resource id.
    expect(calls[1][0]).toContain('https://api.telnyx.com/v2/phone_numbers?');
    expect(decodeURIComponent(calls[1][0])).toContain('filter[phone_number]=+12085550100');
    expect(calls[1][1].method).toBe('GET');

    // Voice → TeXML application connection, keyed by the numeric resource id.
    expect(calls[2][0]).toBe('https://api.telnyx.com/v2/phone_numbers/2990277475533063368/voice');
    expect(calls[2][1].method).toBe('PATCH');
    expect(JSON.parse(calls[2][1].body)).toEqual({ connection_id: '2990188126548264846' });

    // Messaging → messaging profile (from config in tests: 'mp-1'), same id.
    expect(calls[3][0]).toBe('https://api.telnyx.com/v2/phone_numbers/2990277475533063368/messaging');
    expect(calls[3][1].method).toBe('PATCH');
    expect(JSON.parse(calls[3][1].body)).toEqual({ messaging_profile_id: 'mp-1' });
  });

  it('updatePhoneNumber sets CNAM on the voice sub-resource by numeric resource id', async () => {
    global.fetch
      .mockResolvedValueOnce(ok({
        data: [{ id: '2990277475533063368', phone_number: '+12085550100' }],
      })) // GET /phone_numbers?filter -> numeric resource id
      // PATCH /voice
      .mockResolvedValueOnce(ok({ data: { cnam_listing: { cnam_listing_enabled: true } } }));

    const res = await telnyx.updatePhoneNumber('+12085550100', {
      cnam_listing_enabled: true,
      caller_id_name_as: 'Jane Doe',
    });
    expect(res.cnam_listing.cnam_listing_enabled).toBe(true);

    const { calls } = global.fetch.mock;
    expect(decodeURIComponent(calls[0][0])).toContain('filter[phone_number]=+12085550100');
    expect(calls[1][0]).toBe('https://api.telnyx.com/v2/phone_numbers/2990277475533063368/voice');
    expect(calls[1][1].method).toBe('PATCH');
    expect(JSON.parse(calls[1][1].body)).toEqual({
      cnam_listing: { cnam_listing_enabled: true, cnam_listing_details: 'Jane Doe' },
    });
  });

  it('provisionPhoneNumber retries the messaging PATCH once on a 404 (sub-resource not ready)', async () => {
    global.fetch
      .mockResolvedValueOnce(ok({
        data: { id: 'order-1', phone_numbers: [{ phone_number: '+12085550100' }] },
      })) // purchase
      .mockResolvedValueOnce(ok({
        data: [{ id: '2990277475533063368', phone_number: '+12085550100' }],
      })) // GET /phone_numbers?filter
      .mockResolvedValueOnce(ok({ data: {} })) // PATCH /voice
      .mockResolvedValueOnce(fail(404)) // PATCH /messaging — not ready yet
      .mockResolvedValueOnce(ok({ data: {} })); // PATCH /messaging retry — ok

    const res = await telnyx.provisionPhoneNumber('+12085550100');
    expect(res.id).toBe('2990277475533063368');

    const { calls } = global.fetch.mock;
    expect(calls).toHaveLength(5);
    // The 4th and 5th calls are both the messaging PATCH (first 404, then retry).
    expect(calls[3][0]).toBe('https://api.telnyx.com/v2/phone_numbers/2990277475533063368/messaging');
    expect(calls[3][1].method).toBe('PATCH');
    expect(calls[4][0]).toBe('https://api.telnyx.com/v2/phone_numbers/2990277475533063368/messaging');
    expect(calls[4][1].method).toBe('PATCH');
  });

  it('provisionPhoneNumber does NOT retry the messaging PATCH on a non-404 error', async () => {
    global.fetch
      .mockResolvedValueOnce(ok({
        data: { id: 'order-1', phone_numbers: [{ phone_number: '+12085550100' }] },
      })) // purchase
      .mockResolvedValueOnce(ok({
        data: [{ id: '2990277475533063368', phone_number: '+12085550100' }],
      })) // GET /phone_numbers?filter
      .mockResolvedValueOnce(ok({ data: {} })) // PATCH /voice
      .mockResolvedValueOnce(fail(400)); // PATCH /messaging — hard client error

    await expect(telnyx.provisionPhoneNumber('+12085550100'))
      .rejects.toMatchObject({ code: 'TELNYX_ERROR' });
    // No retry: purchase + lookup + voice + the single failed messaging PATCH.
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('provisionPhoneNumber surfaces a persistent 404 after the single messaging retry', async () => {
    global.fetch
      .mockResolvedValueOnce(ok({
        data: { id: 'order-1', phone_numbers: [{ phone_number: '+12085550100' }] },
      })) // purchase
      .mockResolvedValueOnce(ok({
        data: [{ id: '2990277475533063368', phone_number: '+12085550100' }],
      })) // GET /phone_numbers?filter
      .mockResolvedValueOnce(ok({ data: {} })) // PATCH /voice
      .mockResolvedValueOnce(fail(404)) // PATCH /messaging — 404
      .mockResolvedValueOnce(fail(404)); // PATCH /messaging retry — still 404

    await expect(telnyx.provisionPhoneNumber('+12085550100'))
      .rejects.toMatchObject({ code: 'TELNYX_ERROR' });
    // purchase + lookup + voice + messaging(404) + messaging-retry(404) = 5.
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  it('provisionPhoneNumber falls back to the E.164 path form when the lookup finds nothing', async () => {
    global.fetch
      .mockResolvedValueOnce(ok({
        data: { id: 'order-1', phone_numbers: [{ phone_number: '+12085550100' }] },
      })) // purchase
      .mockResolvedValueOnce(ok({ data: [] })) // GET /phone_numbers -> not indexed yet
      .mockResolvedValueOnce(ok({ data: {} })) // PATCH /voice
      .mockResolvedValueOnce(ok({ data: {} })); // PATCH /messaging

    const res = await telnyx.provisionPhoneNumber('+12085550100');
    expect(res.id).toBe('+12085550100');

    const { calls } = global.fetch.mock;
    expect(calls[2][0]).toBe('https://api.telnyx.com/v2/phone_numbers/+12085550100/voice');
    expect(calls[3][0]).toBe('https://api.telnyx.com/v2/phone_numbers/+12085550100/messaging');
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

  it('updateConnectionOutbound PATCHes /credential_connections/{id} with the outbound block', async () => {
    global.fetch.mockResolvedValueOnce(ok({ data: { id: 'conn-9' } }));
    await telnyx.updateConnectionOutbound('conn-9', { ani_override_type: 'default' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/credential_connections/conn-9');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ outbound: { ani_override_type: 'default' } });
  });

  it('createE911Address POSTs /addresses and maps the result', async () => {
    global.fetch.mockResolvedValueOnce(ok({ data: { id: 'addr-1', status: 'pending' } }));
    const res = await telnyx.createE911Address({
      firstName: 'Jane',
      lastName: 'Doe',
      line1: '1 Main St',
      line2: 'Apt 2',
      city: 'Lewiston',
      state: 'ID',
      zip: '83501',
    });
    expect(res).toEqual({ addressId: 'addr-1', status: 'pending' });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/addresses');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      first_name: 'Jane',
      last_name: 'Doe',
      street_address: '1 Main St',
      extended_address: 'Apt 2',
      locality: 'Lewiston',
      administrative_area: 'ID',
      postal_code: '83501',
      country_code: 'US',
      address_book: true,
      business_name: 'MobilityNet Subscriber',
    });
  });

  // Telnyx 422 with USPS suggestion errors (code 10015) — the body carries the
  // normalized field values in each error's `detail`.
  function suggestion422(corrections) {
    const errs = Object.entries(corrections).map(([pointer, detail]) => ({
      code: '10015',
      title: 'Suggestion',
      detail,
      source: { pointer },
    }));
    return { ok: false, status: 422, text: async () => JSON.stringify({ errors: errs }) };
  }

  const baseAddress = {
    firstName: 'Jane',
    lastName: 'Doe',
    line1: '6674 e 118th court',
    line2: '',
    city: 'tulsa',
    state: 'OK',
    zip: '74133',
  };

  it('createE911Address retries with USPS suggestions on a 422 (10015) and succeeds', async () => {
    global.fetch
      .mockResolvedValueOnce(suggestion422({
        '/street_address': '6674 E 118TH CT',
        '/locality': 'TULSA',
        '/postal_code': '74133-6674',
      }))
      .mockResolvedValueOnce(ok({ data: { id: 'addr-9', status: 'pending' } }));

    const res = await telnyx.createE911Address(baseAddress);
    expect(res).toEqual({ addressId: 'addr-9', status: 'pending' });

    // First attempt sent the original values.
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({
      street_address: '6674 e 118th court',
      locality: 'tulsa',
      postal_code: '74133',
    });
    // Retry merged the corrected (USPS-normalized) values; untouched fields kept.
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toMatchObject({
      street_address: '6674 E 118TH CT',
      locality: 'TULSA',
      postal_code: '74133-6674',
      administrative_area: 'OK',
      first_name: 'Jane',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('createE911Address throws on a 422 with no suggestion (10015) errors', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({
        errors: [{
          code: '10009', title: 'Invalid', detail: 'bad', source: { pointer: '/postal_code' },
        }],
      }),
    });

    await expect(telnyx.createE911Address(baseAddress))
      .rejects.toMatchObject({ code: 'TELNYX_ERROR', upstreamStatus: 422 });
    // No retry attempted.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('createE911Address throws (no retry) on a non-422 error', async () => {
    global.fetch.mockResolvedValueOnce(fail(400));

    await expect(telnyx.createE911Address(baseAddress))
      .rejects.toMatchObject({ code: 'TELNYX_ERROR' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('createE911Address surfaces a still-failing 422 retry', async () => {
    global.fetch
      .mockResolvedValueOnce(suggestion422({ '/street_address': '6674 E 118TH CT' }))
      .mockResolvedValueOnce(suggestion422({ '/street_address': '6674 E 118TH CT' }));

    await expect(telnyx.createE911Address(baseAddress))
      .rejects.toMatchObject({ code: 'TELNYX_ERROR', upstreamStatus: 422 });
    // One retry only.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('enableE911 PATCHes /phone_numbers/{id}/voice and maps the result', async () => {
    global.fetch.mockResolvedValueOnce(ok({
      data: { emergency_enabled: true, emergency_status: 'enabled' },
    }));
    const res = await telnyx.enableE911({ phoneNumberId: '+12085550100', addressId: 'addr-1' });
    expect(res).toEqual({ emergencyEnabled: true, emergencyStatus: 'enabled' });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/phone_numbers/+12085550100/voice');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ emergency_enabled: true, emergency_address_id: 'addr-1' });
  });

  it('deleteSipEndpoint hits /telephony_credentials/{id} and returns null on 204', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' });
    const res = await telnyx.deleteSipEndpoint('cred-1');
    expect(res).toBeNull();
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/telephony_credentials/cred-1');
    expect(init.method).toBe('DELETE');
  });

  it('getWebhookPublicKey fetches GET /public_key once and caches the result', async () => {
    telnyx.resetWebhookPublicKeyCache();
    global.fetch.mockResolvedValueOnce(ok({ data: { public_key: 'base64-key' } }));

    const first = await telnyx.getWebhookPublicKey();
    const second = await telnyx.getWebhookPublicKey();

    expect(first).toBe('base64-key');
    expect(second).toBe('base64-key');
    // Cached after the first fetch — the API is hit only once.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.telnyx.com/v2/public_key');
    expect(init.method).toBe('GET');
  });

  it('getWebhookPublicKey returns "" (and caches) when the fetch fails', async () => {
    telnyx.resetWebhookPublicKeyCache();
    global.fetch.mockResolvedValue(fail(500)); // 500 retries then exhausts

    const key = await telnyx.getWebhookPublicKey();
    expect(key).toBe('');
    // Subsequent calls use the cached empty result — no further fetches.
    global.fetch.mockClear();
    expect(await telnyx.getWebhookPublicKey()).toBe('');
    expect(global.fetch).not.toHaveBeenCalled();
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
