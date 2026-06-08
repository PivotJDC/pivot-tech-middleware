jest.mock('../../src/config', () => ({ isProduction: false, admin: { jwtSecret: 'adminsecret', ipAllowlist: [] } }));

const jwt = require('jsonwebtoken');
const config = require('../../src/config');
const { adminAuth, isIpAllowed } = require('../../src/middleware/adminAuth');

function sign(payload) {
  return jwt.sign(payload, 'adminsecret', { algorithm: 'HS256' });
}

beforeEach(() => {
  config.isProduction = false;
  config.admin.jwtSecret = 'adminsecret';
  config.admin.ipAllowlist = [];
});

describe('isIpAllowed', () => {
  it('matches IPv4 CIDR ranges', () => {
    expect(isIpAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(isIpAllowed('192.168.1.5', ['192.168.1.0/24'])).toBe(true);
    expect(isIpAllowed('192.168.2.5', ['192.168.1.0/24'])).toBe(false);
  });
  it('matches exact IPs and normalizes IPv4-mapped IPv6', () => {
    expect(isIpAllowed('1.2.3.4', ['1.2.3.4'])).toBe(true);
    expect(isIpAllowed('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true);
  });
});

describe('adminAuth', () => {
  it('accepts a valid admin token and sets req.admin.id', () => {
    const req = { headers: { authorization: `Bearer ${sign({ sub: 'admin-1' })}` }, ip: '127.0.0.1' };
    const next = jest.fn();
    adminAuth(req, {}, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.admin.id).toBe('admin-1');
  });

  it('rejects a missing Authorization header', () => {
    const req = { headers: {}, ip: '127.0.0.1' };
    const next = jest.fn();
    adminAuth(req, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects a forged token', () => {
    const req = { headers: { authorization: 'Bearer not.a.jwt' }, ip: '127.0.0.1' };
    const next = jest.fn();
    adminAuth(req, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects a token without a subject', () => {
    const req = { headers: { authorization: `Bearer ${sign({ role: 'admin' })}` }, ip: '127.0.0.1' };
    const next = jest.fn();
    adminAuth(req, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects an IP outside the allowlist with FORBIDDEN in production', () => {
    config.isProduction = true;
    config.admin.ipAllowlist = ['10.0.0.0/8'];
    const req = { headers: { authorization: `Bearer ${sign({ sub: 'admin-1' })}` }, ip: '8.8.8.8' };
    const next = jest.fn();
    adminAuth(req, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('skips the IP allowlist outside production', () => {
    config.isProduction = false;
    config.admin.ipAllowlist = ['10.0.0.0/8'];
    const req = { headers: { authorization: `Bearer ${sign({ sub: 'admin-1' })}` }, ip: '8.8.8.8' };
    const next = jest.fn();
    adminAuth(req, {}, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.admin.id).toBe('admin-1');
  });

  it('fails closed when no admin secret is configured', () => {
    config.admin.jwtSecret = '';
    const req = { headers: { authorization: 'Bearer whatever' }, ip: '127.0.0.1' };
    const next = jest.fn();
    adminAuth(req, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });
});
