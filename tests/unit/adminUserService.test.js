jest.mock('../../src/db');
jest.mock('../../src/cache');
jest.mock('../../src/integrations/email');
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
const cache = require('../../src/cache');
const emailClient = require('../../src/integrations/email');
const crypto = require('../../src/utils/crypto');
const adminUserService = require('../../src/services/adminUserService');

beforeEach(() => {
  jest.clearAllMocks();
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

describe('tenant scoping', () => {
  it('login scopes the lookup to the tenant when tenantId is given', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await adminUserService.login('jim', 'pw', 'ten-1');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/username = \$1 AND tenant_id = \$2/);
    expect(params).toEqual(['jim', 'ten-1']);
  });

  it('login matches by username alone when no tenantId (legacy/tests)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await adminUserService.login('jim', 'pw');
    expect(db.query.mock.calls[0][0]).not.toMatch(/tenant_id/);
    expect(db.query.mock.calls[0][1]).toEqual(['jim']);
  });

  it('createAdminUser uses a supplied tenant_id', async () => {
    crypto.hashPassword.mockResolvedValueOnce('hashed');
    db.query.mockResolvedValueOnce({ rows: [{ id: 'u1', tenant_id: 'ten-x' }] });
    await adminUserService.createAdminUser({
      username: 'a', email: 'a@p.io', password: 'password1', tenant_id: 'ten-x',
    });
    expect(db.query.mock.calls[0][1][4]).toBe('ten-x');
  });

  it('listAdminUsers filters by tenant when given', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await adminUserService.listAdminUsers('ten-1');
    expect(db.query.mock.calls[0][0]).toMatch(/WHERE tenant_id = \$1/);
    expect(db.query.mock.calls[0][1]).toEqual(['ten-1']);
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
    // email normalized to lowercase; tenant_id defaults to MobilityNet.
    expect(db.query.mock.calls[0][1]).toEqual([
      'ops', 'ops@p.io', 'hashed', 'admin', '00000000-0000-4000-a000-000000000001',
    ]);
    // Best-effort invite email with the plaintext password.
    expect(emailClient.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'ops@p.io',
      subject: expect.stringMatching(/invited/i),
    }));
  });

  it('still returns the user when the invite email fails', async () => {
    crypto.hashPassword.mockResolvedValueOnce('hashed');
    db.query.mockResolvedValueOnce({ rows: [{ id: 'u9', username: 'ops2', role: 'admin' }] });
    emailClient.sendEmail.mockRejectedValueOnce(new Error('SES down'));

    const user = await adminUserService.createAdminUser({
      username: 'ops2', email: 'ops2@p.io', password: 'longenough',
    });
    expect(user.username).toBe('ops2');
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

describe('updateAdminUserRole', () => {
  it('updates the role when the target is someone else', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ username: 'ops' }] }) // SELECT target
      .mockResolvedValueOnce({ rows: [{ id: 'u2', username: 'ops', role: 'viewer' }] }); // UPDATE

    const user = await adminUserService.updateAdminUserRole('u2', 'viewer', 'jim');

    expect(user).toMatchObject({ role: 'viewer' });
    expect(db.query.mock.calls[1][1]).toEqual(['viewer', 'u2']);
  });

  it('forbids changing your own role (no self-demotion)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ username: 'jim' }] });
    await expect(adminUserService.updateAdminUserRole('u1', 'viewer', 'jim'))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.query).toHaveBeenCalledTimes(1); // no UPDATE
  });

  it('404s for an unknown user', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(adminUserService.updateAdminUserRole('ghost', 'admin', 'jim'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an invalid role before any query', async () => {
    await expect(adminUserService.updateAdminUserRole('u2', 'wizard', 'jim'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'role' });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('deleteAdminUser', () => {
  it('deletes another user', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ username: 'ops' }] }) // SELECT
      .mockResolvedValueOnce({}); // DELETE
    const res = await adminUserService.deleteAdminUser('u2', 'jim');
    expect(res).toEqual({ deleted: true, id: 'u2' });
    expect(db.query.mock.calls[1][0]).toMatch(/DELETE FROM admin_users/);
  });

  it('forbids deleting yourself', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ username: 'jim' }] });
    await expect(adminUserService.deleteAdminUser('u1', 'jim'))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.query).toHaveBeenCalledTimes(1); // no DELETE
  });

  it('404s for an unknown user', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(adminUserService.deleteAdminUser('ghost', 'jim'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('getByUsername', () => {
  it('returns the user (no password_hash) or null', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ username: 'jim', email: 'j@p.io', role: 'admin' }] });
    expect(await adminUserService.getByUsername('jim')).toMatchObject({ email: 'j@p.io' });
    expect(db.query.mock.calls[0][0]).not.toMatch(/password_hash/);

    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await adminUserService.getByUsername('ghost')).toBeNull();
  });
});

describe('requestPasswordReset', () => {
  it('stores a reset token keyed to the username for a known email', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ username: 'jim' }] });
    await adminUserService.requestPasswordReset('Jim@P.io');

    expect(cache.setWithTtl).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = cache.setWithTtl.mock.calls[0];
    expect(key).toMatch(/^admin:reset:/);
    expect(value).toBe('jim');
    expect(ttl).toBe(900);
    // email normalized to lowercase for the lookup.
    expect(db.query.mock.calls[0][1]).toEqual(['jim@p.io']);
    // Emails the reset link to the address on file.
    expect(emailClient.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'jim@p.io',
      subject: expect.stringMatching(/reset/i),
    }));
  });

  it('is a silent no-op for an unknown email', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await adminUserService.requestPasswordReset('ghost@p.io');
    expect(cache.setWithTtl).not.toHaveBeenCalled();
    expect(emailClient.sendEmail).not.toHaveBeenCalled();
  });
});

describe('resetPassword', () => {
  it('updates the password and consumes the token on a valid token', async () => {
    cache.get.mockResolvedValueOnce('jim');
    crypto.hashPassword.mockResolvedValueOnce('newhash');
    db.query.mockResolvedValueOnce({});

    const ok = await adminUserService.resetPassword('tok-1', 'password123');

    expect(ok).toBe(true);
    expect(crypto.hashPassword).toHaveBeenCalledWith('password123');
    expect(db.query.mock.calls[0][1]).toEqual(['newhash', 'jim']);
    expect(cache.del).toHaveBeenCalledWith('admin:reset:tok-1');
  });

  it('returns false for an unknown/expired token (no update)', async () => {
    cache.get.mockResolvedValueOnce(null);
    expect(await adminUserService.resetPassword('bad', 'password123')).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('returns false when no token is supplied', async () => {
    expect(await adminUserService.resetPassword('', 'password123')).toBe(false);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('rejects a too-short new password', async () => {
    await expect(adminUserService.resetPassword('tok', 'short'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'new_password' });
    expect(cache.get).not.toHaveBeenCalled();
  });
});
