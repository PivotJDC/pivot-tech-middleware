const { rateLimit } = require('../../src/middleware/rateLimiter');

/** Minimal Express-ish req/res/next triple. */
function invoke(mw, ip) {
  const req = { ip };
  const res = { set: jest.fn() };
  const next = jest.fn();
  mw(req, res, next);
  return { res, next, err: next.mock.calls[0] && next.mock.calls[0][0] };
}

describe('rateLimit', () => {
  afterEach(() => jest.restoreAllMocks());

  it('allows up to max requests then 429s within the window', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i += 1) {
      const { err } = invoke(mw, '1.2.3.4');
      expect(err).toBeUndefined(); // next() called with no error
    }
    const { err, res } = invoke(mw, '1.2.3.4');
    expect(err).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('tracks each IP independently', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    expect(invoke(mw, '10.0.0.1').err).toBeUndefined();
    expect(invoke(mw, '10.0.0.1').err).toMatchObject({ status: 429 }); // 2nd from same IP
    expect(invoke(mw, '10.0.0.2').err).toBeUndefined(); // different IP unaffected
  });

  it('resets the counter after the window elapses', () => {
    const now = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const mw = rateLimit({ windowMs: 60_000, max: 1 });

    expect(invoke(mw, '5.5.5.5').err).toBeUndefined();
    expect(invoke(mw, '5.5.5.5').err).toMatchObject({ status: 429 });

    // Advance past the window — the bucket resets and requests flow again.
    spy.mockReturnValue(now + 60_001);
    expect(invoke(mw, '5.5.5.5').err).toBeUndefined();
  });
});
