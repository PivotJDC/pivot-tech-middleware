jest.mock('../../src/db');
jest.mock('../../src/utils/crypto');
jest.mock('../../src/config', () => ({
  admin: { jwtSecret: 'test-admin-secret', jwtTtl: '8h' },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const jwt = require('jsonwebtoken');
const db = require('../../src/db');
const crypto = require('../../src/utils/crypto');
const adminUserService = require('../../src/services/adminUserService');

beforeEach(() => {
  db.query.mockReset();
  crypto.hashPassword.mockReset();
  crypto.verifyPassword.mockReset();
});

describe('login', () => {
  const userRow = {
    id: 'u1', username: 'jim', email: 'jim@p.io', password_hash: 'bcrypt$h', role: 'super_admin',
  };

  it('returns a verifiable token + role and stamps last_login_at on valid creds', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [userRow] }) // SELECT by username
      .mockResolvedValueOnce({ rows: [] }); // UPDATE last_login_at
    crypto.verifyPassword.mockResolvedValueOnce(true);

    const result = await adminUserService.login('jim', 'secret123');

    expect(result).toMatchObject({ username: 'jim', role: 'super_admin' });
    const decoded = jwt.verify(result.token, 'test-admin-secret', { algorithms: ['HS256'] });
    expect(decoded.sub).toBe('jim');
    expect(decoded.role).toBe('super_admin');
    expect(decoded.exp).toBeGreaterThan(decoded.iat); // has an expiry
    // last_login_at update fired.
    expect(db.query.mock.calls[1][0]).toMatch(/UPDATE admin_users SET last_login_at/);
  });

  it('returns null on a wrong password (no token, no update)', async () => {
    db.query.mockResolvedValueOnce({ rows: [userRow] });
    crypto.verifyPassword.mockResolvedValueOnce(false);

    expect(await adminUserService.login('jim', 'nope')).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1); // no UPDATE
  });

  it('returns null for an unknown user without calling bcrypt', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await adminUserService.login('ghost', 'x')).toBeNull();
    expect(crypto.verifyPassword).not.toHaveBeenCalled();
  });

  it('returns null when credentials are missing', async () => {
    expect(await adminUserService.login('', '')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('createAdminUser', () => {
  it('hashes the password, inserts, and returns the row without password_hash', async () => {
    crypto.hashPassword.mockResolvedValueOnce('hashed');
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'u2', username: 'ops', email: 'ops@p.io', role: 'admin', created_at: 't',
      }],
    });

    const user = await adminUserService.createAdminUser({
      username: 'ops', email: 'OPS@P.io', password: 'longenough', role: 'admin',
    });

    expect(crypto.hashPassword).toHaveBeenCalledWith('longenough');
    expect(user).not.toHaveProperty('password_hash');
    expect(user.username).toBe('ops');
    // email normalized to lowercase in the insert params.
    expect(db.query.mock.calls[0][1]).toEqual(['ops', 'ops@p.io', 'hashed', 'admin']);
  });

  it('defaults role to admin', async () => {
    crypto.hashPassword.mockResolvedValueOnce('hashed');
    db.query.mockResolvedValueOnce({ rows: [{ id: 'u3', username: 'a', role: 'admin' }] });
    await adminUserService.createAdminUser({ username: 'a', email: 'a@p.io', password: 'password1' });
    expect(db.query.mock.calls[0][1][3]).toBe('admin');
  });

  it.each([
    [{ email: 'a@p.io', password: 'password1' }, 'username'],
    [{ username: 'a', password: 'password1' }, 'email'],
    [{ username: 'a', email: 'a@p.io', password: 'short' }, 'password'],
    [{
      username: 'a', email: 'a@p.io', password: 'password1', role: 'wizard',
    }, 'role'],
  ])('rejects invalid input (%o)', async (input, field) => {
    await expect(adminUserService.createAdminUser(input))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('maps a unique violation to a 409 conflict', async () => {
    crypto.hashPassword.mockResolvedValueOnce('hashed');
    db.query.mockRejectedValueOnce({ code: '23505' });
    await expect(adminUserService.createAdminUser({
      username: 'dup', email: 'dup@p.io', password: 'password1',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 409 });
  });
});

describe('listAdminUsers', () => {
  it('returns rows selected without password_hash', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'u1', username: 'jim', role: 'super_admin' }],
    });
    const users = await adminUserService.listAdminUsers();
    expect(users).toHaveLength(1);
    // The SELECT explicitly omits password_hash.
    expect(db.query.mock.calls[0][0]).not.toMatch(/password_hash/);
  });
});
