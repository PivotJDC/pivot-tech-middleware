jest.mock('../../src/db');

const db = require('../../src/db');
const accountService = require('../../src/services/accountService');

const baseRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'jane@example.com',
  phone_e164: null,
  status: 'pending',
  market: 'lewiston-id',
  plan: 'unlimited_25',
  sip_password_hash: 'bcrypt$secret',
  activated_at: null,
  cancelled_at: null,
};

beforeEach(() => {
  db.query.mockReset();
});

describe('createAccount', () => {
  it('inserts a normalized account and never returns the password hash', async () => {
    db.query.mockResolvedValueOnce({ rows: [baseRow] });

    const result = await accountService.createAccount({
      email: '  Jane@Example.COM ',
      market: ' lewiston-id ',
    });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO accounts/i);
    expect(params).toEqual(['jane@example.com', 'lewiston-id', 'unlimited_25']);
    expect(result).not.toHaveProperty('sip_password_hash');
    expect(result.email).toBe('jane@example.com');
  });

  it('rejects an invalid email before hitting the db', async () => {
    await expect(accountService.createAccount({ email: 'nope', market: 'x' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'email' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects a missing market', async () => {
    await expect(accountService.createAccount({ email: 'a@b.co' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'market' });
  });

  it('rejects an unknown plan', async () => {
    await expect(accountService.createAccount({ email: 'a@b.co', market: 'x', plan: 'gold' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'plan' });
  });

  it('maps a unique-violation to a 409 conflict', async () => {
    db.query.mockRejectedValueOnce({ code: '23505' });
    await expect(accountService.createAccount({ email: 'a@b.co', market: 'x' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 409, field: 'email' });
  });
});

describe('getAccountById', () => {
  it('returns a serialized account', async () => {
    db.query.mockResolvedValueOnce({ rows: [baseRow] });
    const result = await accountService.getAccountById(baseRow.id);
    expect(result.id).toBe(baseRow.id);
    expect(result).not.toHaveProperty('sip_password_hash');
  });

  it('throws NOT_FOUND when missing', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(accountService.getAccountById(baseRow.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an invalid uuid without querying', async () => {
    await expect(accountService.getAccountById('not-a-uuid'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'id' });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('updateAccount status machine', () => {
  it('activates a pending account and stamps activated_at', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'pending', activated_at: null }] }) // fetch
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'active' }] }); // update

    const result = await accountService.updateAccount(baseRow.id, { status: 'active' });

    const updateSql = db.query.mock.calls[1][0];
    expect(updateSql).toMatch(/status = \$1/);
    expect(updateSql).toMatch(/activated_at = NOW\(\)/);
    expect(result.status).toBe('active');
  });

  it('rejects an illegal transition (cancelled -> active) after one fetch', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'cancelled' }] });
    await expect(accountService.updateAccount(baseRow.id, { status: 'active' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'status' });
    expect(db.query).toHaveBeenCalledTimes(1); // only the fetch, no update
  });

  it('stamps cancelled_at when cancelling', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'cancelled' }] });
    await accountService.updateAccount(baseRow.id, { status: 'cancelled' });
    expect(db.query.mock.calls[1][0]).toMatch(/cancelled_at = NOW\(\)/);
  });

  it('throws when no updatable fields are provided', async () => {
    db.query.mockResolvedValueOnce({ rows: [baseRow] });
    await expect(accountService.updateAccount(baseRow.id, {}))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('updates email only', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [baseRow] })
      .mockResolvedValueOnce({ rows: [{ ...baseRow, email: 'new@example.com' }] });
    const result = await accountService.updateAccount(baseRow.id, { email: 'New@Example.com' });
    expect(db.query.mock.calls[1][1]).toContain('new@example.com');
    expect(result.email).toBe('new@example.com');
  });
});

describe('serializeAccount', () => {
  it('strips the password hash', () => {
    expect(accountService.serializeAccount(baseRow)).not.toHaveProperty('sip_password_hash');
  });
  it('passes through null/undefined', () => {
    expect(accountService.serializeAccount(null)).toBeNull();
  });
});
