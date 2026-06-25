jest.mock('../../src/db');
jest.mock('../../src/services/didOrchestrationService');
jest.mock('../../src/integrations/bics');
jest.mock('../../src/utils/crypto');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const didOrchestration = require('../../src/services/didOrchestrationService');
const bics = require('../../src/integrations/bics');
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
  bics_endpoint_id: null,
  bics_iccid: null,
  bics_provisioned: false,
  activated_at: null,
  cancelled_at: null,
};

// A successful BICS eSIM provisioning chain (getNextAvailableEsim ->
// createEndpoint -> activateEndpoint -> fetchSimByIccid).
function wireBicsSuccess(iccid = 'icc-1', endpointId = 'ep-bics-1') {
  bics.getNextAvailableEsim.mockResolvedValueOnce(iccid);
  bics.createEndpoint.mockResolvedValueOnce({
    Response: { responseParam: { endPointId: endpointId } },
  });
  bics.activateEndpoint.mockResolvedValueOnce({});
  bics.fetchSimByIccid.mockResolvedValueOnce({
    endPointId: endpointId,
    activationCode: {
      textQrCode: 'LPA:1$thales3.prod.ondemandconnectivity.com$MATCH-1',
      smDpPlusAdress: 'thales3.prod.ondemandconnectivity.com',
      matchingId: 'MATCH-1',
    },
  });
}

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
  bics.getNextAvailableEsim.mockReset();
  bics.createEndpoint.mockReset();
  bics.activateEndpoint.mockReset();
  bics.fetchSimByIccid.mockReset();
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

  it.each(['starter_10', 'unlimited_25', 'unlimited_25_plus'])(
    'accepts the %s plan slug and persists it',
    async (plan) => {
      db.query.mockResolvedValueOnce({ rows: [] }); // email pre-check
      didOrchestration.assignDid.mockResolvedValueOnce(credentials);
      crypto.hashPassword.mockResolvedValueOnce('hashed-pw');
      let insertedPlan;
      db.withTransaction.mockImplementationOnce(async (fn) => {
        const client = {
          query: jest.fn()
            .mockImplementationOnce((_sql, params) => {
              // INSERT account — params order: (email, market, plan, ...)
              [, , insertedPlan] = params;
              return { rows: [{ ...baseRow, plan }] };
            })
            .mockResolvedValueOnce({ rows: [] }), // INSERT did
        };
        return fn(client);
      });

      const result = await accountService.createAccount({
        email: 'a@b.co', market: 'lewiston-id', plan,
      });
      expect(insertedPlan).toBe(plan);
      expect(result.plan).toBe(plan);
    },
  );

  it('rejects an unknown plan slug before any work', async () => {
    await expect(accountService.createAccount({
      email: 'a@b.co', market: 'lewiston-id', plan: 'bogus_plan',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'plan' });
    expect(db.query).not.toHaveBeenCalled();
    expect(didOrchestration.assignDid).not.toHaveBeenCalled();
  });

  it('happy path: provisions DID and eSIM, returns the activation code', async () => {
    wireHappyPath();
    wireBicsSuccess('icc-1', 'ep-bics-1');
    // The post-provisioning UPDATE returns the row with BICS fields set.
    db.query.mockResolvedValueOnce({
      rows: [{
        ...baseRow, bics_endpoint_id: 'ep-bics-1', bics_iccid: 'icc-1', bics_provisioned: true,
      }],
    });

    const result = await accountService.createAccount({ email: 'a@b.co', market: 'lewiston-id' });

    expect(bics.getNextAvailableEsim).toHaveBeenCalled();
    expect(bics.createEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ name: `mobilitynet-${baseRow.id.slice(0, 8)}`, iccid: 'icc-1' }),
    );
    expect(bics.activateEndpoint).toHaveBeenCalledWith('ep-bics-1');
    expect(result.esim).toEqual({
      iccid: 'icc-1',
      endpointId: 'ep-bics-1',
      activationCode: 'LPA:1$thales3.prod.ondemandconnectivity.com$MATCH-1',
      smDpAddress: 'thales3.prod.ondemandconnectivity.com',
    });
    expect(result).not.toHaveProperty('esim_error');
    expect(result.bics_provisioned).toBe(true);
    // UPDATE persists endpoint id, iccid, and the provisioned flag.
    const updateCall = db.query.mock.calls.find(([sql]) => /UPDATE accounts/.test(sql));
    expect(updateCall[1]).toEqual(['ep-bics-1', 'icc-1', baseRow.id]);
  });

  it('BICS failure: account still created with esim=null and bics_provisioned=false', async () => {
    wireHappyPath();
    bics.getNextAvailableEsim.mockResolvedValueOnce('icc-1');
    bics.createEndpoint.mockResolvedValueOnce({ Response: { responseParam: { endPointId: 'ep-1' } } });
    bics.activateEndpoint.mockRejectedValueOnce(
      Object.assign(new Error('SIM not attached'), { code: 'BICS_ERROR' }),
    );

    const result = await accountService.createAccount({ email: 'a@b.co', market: 'lewiston-id' });

    // Account is kept (DID already purchased) — no rollback.
    expect(result.id).toBe(baseRow.id);
    expect(result.esim).toBeNull();
    expect(result.esim_error).toBe('BICS provisioning failed — retry from admin');
    expect(result.bics_provisioned).toBe(false);
    // No UPDATE ran (provisioning failed before persistence).
    expect(db.query.mock.calls.some(([sql]) => /UPDATE accounts/.test(sql))).toBe(false);
  });

  it('eSIM pool exhaustion does not roll back the account', async () => {
    wireHappyPath();
    bics.getNextAvailableEsim.mockRejectedValueOnce(
      Object.assign(new Error('No available eSIMs in the BICS pool.'), { code: 'BICS_ERROR' }),
    );

    const result = await accountService.createAccount({ email: 'a@b.co', market: 'lewiston-id' });

    expect(result.id).toBe(baseRow.id);
    expect(result.esim).toBeNull();
    expect(result.esim_error).toBe('BICS provisioning failed — retry from admin');
    expect(bics.createEndpoint).not.toHaveBeenCalled();
  });
});

describe('retryBicsProvisioning', () => {
  it('re-runs provisioning for an unprovisioned account and persists the eSIM', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ ...baseRow, bics_provisioned: false }] }) // SELECT
      .mockResolvedValueOnce({
        rows: [{
          ...baseRow, bics_endpoint_id: 'ep-bics-1', bics_iccid: 'icc-1', bics_provisioned: true,
        }],
      }); // UPDATE RETURNING
    wireBicsSuccess('icc-1', 'ep-bics-1');

    const result = await accountService.retryBicsProvisioning(baseRow.id);

    expect(result.bics_provisioned).toBe(true);
    expect(result.esim.endpointId).toBe('ep-bics-1');
    expect(result.esim.activationCode).toMatch(/^LPA:1\$/);
    const updateCall = db.query.mock.calls.find(([sql]) => /UPDATE accounts/.test(sql));
    expect(updateCall[1]).toEqual(['ep-bics-1', 'icc-1', baseRow.id]);
  });

  it('rejects when the account is already provisioned', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...baseRow, bics_provisioned: true }] });
    await expect(accountService.retryBicsProvisioning(baseRow.id))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'action' });
    expect(bics.getNextAvailableEsim).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND for a missing account', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(accountService.retryBicsProvisioning(baseRow.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('surfaces a BICS failure to the caller (no swallow on retry)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...baseRow, bics_provisioned: false }] });
    bics.getNextAvailableEsim.mockRejectedValueOnce(
      Object.assign(new Error('pool exhausted'), { code: 'BICS_ERROR' }),
    );
    await expect(accountService.retryBicsProvisioning(baseRow.id))
      .rejects.toMatchObject({ code: 'BICS_ERROR' });
  });
});

describe('multi-line (family plan)', () => {
  it('creates a child line under an existing primary with its own DID + eSIM', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'parent-1' }] }); // parent lookup
    didOrchestration.assignDid.mockResolvedValueOnce(credentials);
    crypto.hashPassword.mockResolvedValueOnce('hashed-pw');
    let insertedParams;
    db.withTransaction.mockImplementationOnce(async (fn) => {
      const client = {
        query: jest.fn()
          .mockImplementationOnce((_sql, params) => {
            insertedParams = params;
            return { rows: [{ ...baseRow, parent_account_id: 'parent-1', line_label: 'Kid 1' }] };
          })
          .mockResolvedValueOnce({ rows: [] }), // INSERT did
      };
      return fn(client);
    });
    wireBicsSuccess('icc-2', 'ep-2');
    db.query.mockResolvedValueOnce({
      rows: [{
        ...baseRow, parent_account_id: 'parent-1', line_label: 'Kid 1', bics_provisioned: true,
      }],
    }); // eSIM UPDATE

    const result = await accountService.createAccount({
      email: 'jane@example.com',
      market: 'lewiston-id',
      parent_email: 'jane@example.com',
      line_label: 'Kid 1',
    });

    // Parent resolved against primary accounts only; uniqueness pre-check skipped.
    expect(db.query.mock.calls[0][0]).toMatch(/parent_account_id IS NULL/);
    // Child line still gets its own DID and eSIM.
    expect(didOrchestration.assignDid).toHaveBeenCalledWith('lewiston-id');
    expect(bics.getNextAvailableEsim).toHaveBeenCalled();
    // parent_account_id ($8) and line_label ($9) persisted.
    expect(insertedParams[7]).toBe('parent-1');
    expect(insertedParams[8]).toBe('Kid 1');
    expect(result.parent_account_id).toBe('parent-1');
    expect(result.esim.endpointId).toBe('ep-2');
  });

  it('rejects a child line when parent_email has no primary account', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // parent lookup: none
    await expect(accountService.createAccount({
      email: 'x@y.co', market: 'lewiston-id', parent_email: 'missing@y.co',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // No DID purchased for an invalid parent.
    expect(didOrchestration.assignDid).not.toHaveBeenCalled();
  });

  describe('getAccountLines', () => {
    it('returns the child lines under a primary', async () => {
      db.query.mockResolvedValueOnce({
        rows: [
          { ...baseRow, id: '22222222-2222-4222-8222-222222222222', parent_account_id: baseRow.id },
          { ...baseRow, id: '33333333-3333-4333-8333-333333333333', parent_account_id: baseRow.id },
        ],
      });
      const lines = await accountService.getAccountLines(baseRow.id);
      expect(lines).toHaveLength(2);
      expect(lines[0].parent_account_id).toBe(baseRow.id);
      expect(lines[0]).not.toHaveProperty('sip_password_hash');
      expect(db.query.mock.calls[0][0]).toMatch(/parent_account_id = \$1/);
      expect(db.query.mock.calls[0][1]).toEqual([baseRow.id]);
    });

    it('rejects an invalid uuid without querying', async () => {
      await expect(accountService.getAccountLines('nope'))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(db.query).not.toHaveBeenCalled();
    });
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
  it('exposes line_count for a primary account (from the query column)', () => {
    const result = accountService.serializeAccount({ ...baseRow, parent_account_id: null, line_count: '3' });
    expect(result.line_count).toBe(3);
  });
  it('defaults line_count to 0 for a primary with no count column', () => {
    expect(accountService.serializeAccount(baseRow).line_count).toBe(0);
  });
  it('omits line_count for a child line and exposes parent_account_id/line_label', () => {
    const result = accountService.serializeAccount({
      ...baseRow, parent_account_id: 'parent-1', line_label: 'Kid 1',
    });
    expect(result).not.toHaveProperty('line_count');
    expect(result.parent_account_id).toBe('parent-1');
    expect(result.line_label).toBe('Kid 1');
  });
});
