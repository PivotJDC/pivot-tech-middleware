// Mock config: BICS credentials shape + tiny retry base so backoff is fast.
jest.mock('../../src/config', () => ({
  bics: {
    username: 'svc-user',
    password: 'svc-pass',
    baseUrl: 'https://sft.bics.com/api',
    planId: 'plan-1',
    apnGroupId: 'apn-1',
    roamingProfileId: 'roam-1',
    retryBaseMs: 1,
  },
  logLevel: 'silent',
  isProduction: true,
}));

// The module caches the access token in memory, so reset the module registry
// (and re-require) before each test to start from a clean, unauthenticated state.
let bics;

function loginOk(token = 'tok-1') {
  return { ok: true, status: 200, text: async () => JSON.stringify({ AccessToken: token }) };
}
function envOk(responseParam, resultCode = '0') {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      Response: { resultCode, resultParam: {}, responseParam },
    }),
  };
}
function status(code, bodyText = '') {
  return { ok: code >= 200 && code < 300, status: code, text: async () => bodyText };
}

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  // eslint-disable-next-line global-require
  bics = require('../../src/integrations/bics');
});
afterAll(() => {
  delete global.fetch;
});

describe('authentication and token caching', () => {
  it('logs in once with capital-A AccessToken and reuses the cached token', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk('tok-1')) // POST /login
      .mockResolvedValueOnce(envOk({ rows: [] })) // GET /fetchSIM
      .mockResolvedValueOnce(envOk({ rows: [] })); // GET /fetchSIM again

    await bics.fetchSimInventory();
    await bics.fetchSimInventory();

    const loginCalls = global.fetch.mock.calls.filter(([url]) => url.endsWith('/login'));
    expect(loginCalls).toHaveLength(1);

    // Login body carries the credentials and the XHR header.
    const [loginUrl, loginInit] = loginCalls[0];
    expect(loginUrl).toBe('https://sft.bics.com/api/login');
    expect(JSON.parse(loginInit.body)).toEqual({ username: 'svc-user', password: 'svc-pass' });
    expect(loginInit.headers['X-Requested-With']).toBe('XMLHttpRequest');

    // Data request carries the token in X-Authorization (NOT Authorization).
    const [, dataInit] = global.fetch.mock.calls[1];
    expect(dataInit.headers['X-Authorization']).toBe('Bearer tok-1');
    expect(dataInit.headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(dataInit.headers.Authorization).toBeUndefined();
  });

  it('throws BICS_ERROR when login returns no AccessToken', async () => {
    global.fetch.mockResolvedValueOnce(status(200, JSON.stringify({})));
    await expect(bics.authenticate()).rejects.toMatchObject({ code: 'BICS_ERROR', status: 502 });
  });

  it('throws BICS_ERROR when login itself fails', async () => {
    global.fetch.mockResolvedValueOnce(status(403, 'forbidden'));
    await expect(bics.authenticate()).rejects.toMatchObject({ code: 'BICS_ERROR' });
  });
});

describe('auto-refresh on 401', () => {
  it('re-authenticates and replays the request once on a 401', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk('tok-1')) // initial login
      .mockResolvedValueOnce(status(401)) // token expired
      .mockResolvedValueOnce(loginOk('tok-2')) // re-auth
      .mockResolvedValueOnce(envOk({ rows: [{ iccid: 'icc-1' }] })); // replay succeeds

    const rows = await bics.fetchSimInventory();
    expect(rows).toEqual([{ iccid: 'icc-1' }]);

    // The replayed data request uses the refreshed token.
    const replay = global.fetch.mock.calls[3];
    expect(replay[1].headers['X-Authorization']).toBe('Bearer tok-2');
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('does not loop forever — a persistent 401 surfaces as a client error', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk('tok-1'))
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(loginOk('tok-2'))
      .mockResolvedValueOnce(status(401));
    await expect(bics.fetchSimInventory()).rejects.toMatchObject({ code: 'BICS_ERROR' });
  });
});

describe('fetchSimByIccid', () => {
  it('returns the SIM with its eSIM activation code', async () => {
    const sim = {
      iccid: '8988303000000000001',
      eid: 'eid-123',
      simStatus: 'Ready To Activate',
      endPointId: '-',
      activationCode: {
        textQrCode: 'LPA:1$smdp.example.com$MATCH-123',
        smDpPlusAdress: 'smdp.example.com',
        matchingId: 'MATCH-123',
      },
    };
    global.fetch
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(envOk({ rows: [sim] }));

    const res = await bics.fetchSimByIccid('8988303000000000001');
    expect(res).toEqual(sim);
    expect(res.activationCode.textQrCode).toBe('LPA:1$smdp.example.com$MATCH-123');
    expect(res.activationCode.smDpPlusAdress).toBe('smdp.example.com');
    expect(res.activationCode.matchingId).toBe('MATCH-123');

    const [url, init] = global.fetch.mock.calls[1];
    expect(url).toBe('https://sft.bics.com/api/fetchSIM?iccid=8988303000000000001');
    expect(init.method).toBe('GET');
  });

  it('returns null when no SIM matches the ICCID', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(envOk({ rows: [] }));
    expect(await bics.fetchSimByIccid('missing')).toBeNull();
  });
});

describe('getNextAvailableEsim filtering', () => {
  it('returns the first ready, unassigned consumer eUICC ICCID', async () => {
    const rows = [
      {
        iccid: 'skip-status', simProduct: 'IPP Consumer eUICC LPWAN', simStatus: 'Activated', endPointId: '-',
      },
      {
        iccid: 'skip-product', simProduct: 'OTHER PRODUCT', simStatus: 'Ready To Activate', endPointId: '-',
      },
      {
        iccid: 'skip-assigned', simProduct: 'IPP Consumer eUICC LPWAN', simStatus: 'Ready To Activate', endPointId: 'ep-9',
      },
      {
        iccid: 'winner', simProduct: 'IPP Consumer eUICC LPWAN', simStatus: 'Ready To Activate', endPointId: '-',
      },
      {
        iccid: 'also-ok', simProduct: 'IPP Consumer eUICC LPWAN', simStatus: 'Ready To Activate', endPointId: '-',
      },
    ];
    global.fetch
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(envOk({ rows }));
    expect(await bics.getNextAvailableEsim()).toBe('winner');
  });

  it('throws BICS_ERROR when the pool is exhausted', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(envOk({ rows: [] }));
    await expect(bics.getNextAvailableEsim()).rejects.toMatchObject({ code: 'BICS_ERROR', status: 502 });
  });
});

describe('createEndpoint', () => {
  it('sends the BICS Request envelope, defaulting plan/APN/roaming from config', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(envOk({}));

    await bics.createEndpoint({ name: 'pivottech-acct', iccid: 'icc-1' });

    const [url, init] = global.fetch.mock.calls[1];
    expect(url).toBe('https://sft.bics.com/api/CreateEndPoint');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      Request: {
        requestParam: {
          name: 'pivottech-acct',
          apnGroupId: 'apn-1',
          roamingProfileId: 'roam-1',
          isLinkSIM: 'true',
          iccid: 'icc-1',
          isDefaultActivation: 'false',
          planId: 'plan-1',
          monthlyLimit: '1000',
        },
      },
    });
  });

  it('lets explicit args override the config defaults', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(envOk({}));

    await bics.createEndpoint({
      name: 'n', iccid: 'i', planId: 'p2', apnGroupId: 'a2', roamingProfileId: 'r2', monthlyLimit: '5000',
    });
    const body = JSON.parse(global.fetch.mock.calls[1][1].body).Request.requestParam;
    expect(body.planId).toBe('p2');
    expect(body.apnGroupId).toBe('a2');
    expect(body.roamingProfileId).toBe('r2');
    expect(body.monthlyLimit).toBe('5000');
  });
});

describe('error handling', () => {
  it('throws BICS_ERROR on a business-failure envelope (resultCode "1")', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          Response: {
            resultCode: '1',
            resultParam: { resultCode: 'E42', resultDescription: 'something broke' },
            responseParam: {},
          },
        }),
      });
    await expect(bics.fetchSimInventory()).rejects.toMatchObject({ code: 'BICS_ERROR', status: 502 });
  });

  it('does NOT retry a 4xx client error', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValue(status(400, 'bad request'));
    await expect(bics.fetchSimInventory()).rejects.toMatchObject({ code: 'BICS_ERROR' });
    // 1 login + 1 data attempt (no retries on 4xx).
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx and gives up after 4 attempts (1 + 3 retries)', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValue(status(500, 'server error'));
    await expect(bics.fetchSimInventory()).rejects.toMatchObject({ code: 'BICS_ERROR', status: 502 });
    // 1 login + 4 data attempts.
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  it('retries on a network error then succeeds', async () => {
    global.fetch
      .mockResolvedValueOnce(loginOk())
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(envOk({ rows: [] }));
    expect(await bics.fetchSimInventory()).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('unimplemented endpoint stubs throw BICS_ERROR', async () => {
    await expect(bics.activateEndpoint('ep-1')).rejects.toMatchObject({ code: 'BICS_ERROR' });
    await expect(bics.getEndpointStatistics('ep-1')).rejects.toMatchObject({ code: 'BICS_ERROR' });
    await expect(bics.changeEndpointStatus('ep-1', 'suspended')).rejects.toMatchObject({ code: 'BICS_ERROR' });
  });
});
