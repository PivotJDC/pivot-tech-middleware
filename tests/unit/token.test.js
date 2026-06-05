// Mock config with a freshly generated RS256 keypair so JWT sign/verify works
// without depending on real environment keys.
jest.mock('../../src/config', () => {
  // eslint-disable-next-line global-require
  const { generateKeyPairSync } = require('crypto');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    jwt: { signingKey: privateKey, publicKey, customerTtl: '24h' },
  };
});

const token = require('../../src/utils/token');

describe('provisioning tokens', () => {
  it('generates a URL-safe token and a stable SHA-256 hash', () => {
    const raw = token.generateProvisioningToken();
    expect(typeof raw).toBe('string');
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding

    const hash = token.hashProvisioningToken(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.hashProvisioningToken(raw)).toBe(hash); // deterministic
  });

  it('produces distinct tokens each call', () => {
    expect(token.generateProvisioningToken()).not.toBe(token.generateProvisioningToken());
  });

  it('throws when hashing an invalid token', () => {
    expect(() => token.hashProvisioningToken('')).toThrow();
    expect(() => token.hashProvisioningToken(null)).toThrow();
  });
});

describe('customer JWT', () => {
  it('signs and verifies a token round-trip', () => {
    const jwt = token.signCustomerToken({ sub: 'acc-123', market: 'lewiston-id' });
    const claims = token.verifyCustomerToken(jwt);
    expect(claims.sub).toBe('acc-123');
    expect(claims.market).toBe('lewiston-id');
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it('requires a sub claim', () => {
    expect(() => token.signCustomerToken({})).toThrow(/sub/);
  });

  it('throws TokenExpiredError for an expired token', () => {
    const jwt = token.signCustomerToken({ sub: 'acc-123' }, { expiresIn: '-1s' });
    expect.assertions(1);
    try {
      token.verifyCustomerToken(jwt);
    } catch (err) {
      expect(err.name).toBe('TokenExpiredError');
    }
  });

  it('rejects a forged/garbage token', () => {
    expect(() => token.verifyCustomerToken('not.a.jwt')).toThrow();
  });
});
