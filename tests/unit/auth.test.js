// Real RS256 keypair via mocked config, so token sign/verify works end-to-end.
jest.mock('../../src/config', () => {
  // eslint-disable-next-line global-require
  const { generateKeyPairSync } = require('crypto');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { jwt: { signingKey: privateKey, publicKey, customerTtl: '24h' } };
});

const token = require('../../src/utils/token');
const { authenticate, requireSelf } = require('../../src/middleware/auth');

function mockRes() {
  return {};
}

describe('authenticate', () => {
  it('attaches req.auth for a valid token', () => {
    const jwt = token.signCustomerToken({ sub: 'acc-1' });
    const req = { headers: { authorization: `Bearer ${jwt}` } };
    const next = jest.fn();

    authenticate(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(); // no error
    expect(req.auth.accountId).toBe('acc-1');
  });

  it('rejects a missing Authorization header with UNAUTHORIZED', () => {
    const req = { headers: {} };
    const next = jest.fn();
    authenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects a non-Bearer scheme', () => {
    const req = { headers: { authorization: 'Basic abc' } };
    const next = jest.fn();
    authenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects an expired token as UNAUTHORIZED (not TOKEN_EXPIRED)', () => {
    const jwt = token.signCustomerToken({ sub: 'acc-1' }, { expiresIn: '-1s' });
    const req = { headers: { authorization: `Bearer ${jwt}` } };
    const next = jest.fn();
    authenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    expect(req.authError).toBe('TokenExpiredError');
  });
});

describe('requireSelf', () => {
  it('passes when the token subject matches :id', () => {
    const req = { auth: { accountId: 'acc-1' }, params: { id: 'acc-1' } };
    const next = jest.fn();
    requireSelf(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('forbids access to another account', () => {
    const req = { auth: { accountId: 'acc-1' }, params: { id: 'acc-2' } };
    const next = jest.fn();
    requireSelf(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('requires prior authentication', () => {
    const req = { params: { id: 'acc-1' } };
    const next = jest.fn();
    requireSelf(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });
});
