jest.mock('../../src/cache');
jest.mock('../../src/services/accountService');
jest.mock('../../src/utils/token');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const cache = require('../../src/cache');
const accountService = require('../../src/services/accountService');
const token = require('../../src/utils/token');
const { errors } = require('../../src/middleware/errorHandler');
const authService = require('../../src/services/authService');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sendCode', () => {
  it('stores a 6-digit code with a 10-minute TTL for a known account', async () => {
    accountService.getAccountByEmail.mockResolvedValueOnce({ id: 'acc-1' });

    await authService.sendCode('Jane@Example.com');

    expect(cache.setWithTtl).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = cache.setWithTtl.mock.calls[0];
    expect(key).toBe('auth:code:jane@example.com'); // normalized
    expect(value).toMatch(/^\d{6}$/);
    expect(ttl).toBe(600);
  });

  it('is a silent no-op for an unknown email (no enumeration)', async () => {
    accountService.getAccountByEmail.mockRejectedValueOnce(errors.notFound('No account.'));

    await expect(authService.sendCode('ghost@example.com')).resolves.toBeUndefined();
    expect(cache.setWithTtl).not.toHaveBeenCalled();
  });
});

describe('verifyCode', () => {
  it('returns a token + account and consumes the code on a match', async () => {
    cache.get.mockResolvedValueOnce('123456');
    accountService.getAccountByEmail.mockResolvedValueOnce({ id: 'acc-1', email: 'jane@example.com' });
    token.signCustomerToken.mockReturnValueOnce('signed.jwt');

    const result = await authService.verifyCode('jane@example.com', '123456');

    expect(result).toEqual({ token: 'signed.jwt', account: { id: 'acc-1', email: 'jane@example.com' } });
    expect(token.signCustomerToken).toHaveBeenCalledWith({ sub: 'acc-1' });
    // Code consumed (single-use).
    expect(cache.del).toHaveBeenCalledWith('auth:code:jane@example.com');
  });

  it('returns null on a wrong code and does NOT consume it', async () => {
    cache.get.mockResolvedValueOnce('123456');
    const result = await authService.verifyCode('jane@example.com', '000000');
    expect(result).toBeNull();
    expect(cache.del).not.toHaveBeenCalled();
    expect(token.signCustomerToken).not.toHaveBeenCalled();
  });

  it('returns null when the code has expired / is absent', async () => {
    cache.get.mockResolvedValueOnce(null); // TTL elapsed -> key gone
    const result = await authService.verifyCode('jane@example.com', '123456');
    expect(result).toBeNull();
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('returns null when no code is supplied', async () => {
    const result = await authService.verifyCode('jane@example.com', '');
    expect(result).toBeNull();
    expect(cache.get).not.toHaveBeenCalled();
  });
});
