jest.mock('../../src/db');
jest.mock('../../src/services/didOrchestrationService');
jest.mock('../../src/utils/crypto');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const didOrchestration = require('../../src/services/didOrchestrationService');
const crypto = require('../../src/utils/crypto');
const accountService = require('../../src/services/accountService');

const baseRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'jane@example.com',
  phone_e164: '+12085550100',
  status: 'pending',
  market: 'lewiston-id',
  plan: 'unlimited_25',
  sip_username: 'pivottech-abc',
  sip_endpoint_id: 'ep-1',
  sip_password_hash: 'bcrypt$secret',
  activated_at: null,
  cancelled_at: null,
};

const credentials = {
  phoneE164: '+12085550100',
  areaCode: '208',
  signalwireSid: 'sid-1',
  sipUsername: 'pivottech-abc',
  sipEndpointId: 'ep-1',
  sipPassword: 'plaintext-pw',
};

beforeEach(() => {
  db.query.mockReset();
  db.withTransaction.mockReset();
  didOrchestration.assignDid.mockReset();
  crypto.hashPassword.mockReset();
});

describe('createAccount', () => {
  function wireHappyPath() {
    db.query.mockResolvedValueOnce({ rows: [] }); // email pre-check: not taken
    didOrchestration.assignDid.mockResolvedValueOnce(credentials);
    crypto.hashPassword.mockResolvedValueOnce('hashed-pw');
    db.withTransaction.mockImplementationOnce(async (fn) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [baseRow] }) // INSERT account
          .mockResolvedValueOnce({ rows: [] }), // INSERT did
      };
      return fn(client);
    });
  }

  it('orchestrates DID assignment and persists account + did', async () => {
    wireHappyPath();

    const result = await accountService.createAccount({
      email: '  Jane@Example.COM ',
      market: 'lewiston-id',
    });

    expect(didOrchestration.assignDid).toHaveBeenCalledWith('lewiston-id');
    expect(crypto.hashPassword).toHaveBeenCalledWith('plaintext-pw');
    expect(result.id).toBe(baseRow.id);
    expect(result).not.toHaveProperty('sip_password_hash');
  });

  it('rejects a duplicate email before purchasing a DID', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'existing' }] });
    await expect(accountService.createAccount({ email: 'a@b.co', market: 'lewiston-id' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 409, field: 'email' });
    expect(didOrchestration.assignDid).not.toHaveBeenCalled();
  });

  it('propagates a DID_UNAVAILABLE failure and writes nothing', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    didOrchestration.assignDid.mockRejectedValueOnce(
      Object.assign(new Error('none'), { code: 'DID_UNAVAILABLE' }),
    );
    await expect(accountService.createAccount({ email: 'a@b.co', market: 'lewiston-id' }))
      .rejects.toMatchObject({ code: 'DID_UNAVAILABLE' });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it('maps a unique-violation race in the transaction to a 409', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    didOrchestration.assignDid.mockResolvedValueOnce(credentials);
    crypto.hashPassword.mockResolvedValueOnce('hashed-pw');
    db.withTransaction.mockRejectedValueOnce({ code: '23505' });
    await expect(accountService.createAccount({ email: 'a@b.co', market: 'lewiston-id' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 409 });
  });

  it('rejects an invalid email before any work', async () => {
    await expect(accountService.createAccount({ email: 'nope', market: 'lewiston-id' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'email' });
    expect(db.query).not.toHaveBeenCalled();
    expect(didOrchestration.assignDid).not.toHaveBeenCalled();
  });
});

describe('getAccountByEmail', () => {
  it('returns a serialized account', async () => {
    db.query.mockResolvedValueOnce({ rows: [baseRow] });
    const result = await accountService.getAccountByEmail('JANE@example.com');
    expect(db.query.mock.calls[0][1]).toEqual(['jane@example.com']);
    expect(result).not.toHaveProperty('sip_password_hash');
  });

  it('throws NOT_FOUND when no account matches', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(accountService.getAccountByEmail('missing@example.com'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
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
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'pending', activated_at: null }] })
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'active' }] });

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
    expect(db.query).toHaveBeenCalledTimes(1);
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
});

describe('serializeAccount', () => {
  it('strips the password hash', () => {
    expect(accountService.serializeAccount(baseRow)).not.toHaveProperty('sip_password_hash');
  });
  it('passes through null', () => {
    expect(accountService.serializeAccount(null)).toBeNull();
  });
});
