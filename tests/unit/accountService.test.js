jest.mock('../../src/db');
jest.mock('../../src/services/didOrchestrationService');
jest.mock('../../src/services/telgoo5Service');
jest.mock('../../src/integrations/bics');
jest.mock('../../src/utils/crypto');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const didOrchestration = require('../../src/services/didOrchestrationService');
const telgoo5Service = require('../../src/services/telgoo5Service');
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
  e911AddressId: 'addr-9',
  e911Enabled: true,
};

beforeEach(() => {
  db.query.mockReset();
  db.withTransaction.mockReset();
  didOrchestration.assignDid.mockReset();
  crypto.hashPassword.mockReset();
  bics.getNextAvailableEsim.mockReset();
  bics.createEndpoint.mockReset();
  bics.activateEndpoint.mockReset();
  bics.updateThreshold.mockReset();
  bics.fetchSimByIccid.mockReset();
  telgoo5Service.syncAccountToTelgoo5.mockReset();
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

    expect(didOrchestration.assignDid).toHaveBeenCalledWith('lewiston-id', null, { firstName: null, lastName: null, serviceAddress: null });
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
    // The plan's data cap (unlimited_25 = 30720 MB) is pushed to BICS as the
    // endpoint threshold (best-effort).
    expect(bics.updateThreshold).toHaveBeenCalledWith(
      'ep-bics-1',
      expect.objectContaining({ threshold: '30720' }),
    );
    expect(result.esim).toEqual({
      iccid: 'icc-1',
      endpointId: 'ep-bics-1',
      activationCode: 'LPA:1$thales3.prod.ondemandconnectivity.com$MATCH-1',
      smDpAddress: 'thales3.prod.ondemandconnectivity.com',
    });
    expect(result).not.toHaveProperty('esim_error');
    expect(result.bics_provisioned).toBe(true);
    // UPDATE persists endpoint id, iccid, activation code, and the flag.
    const updateCall = db.query.mock.calls.find(([sql]) => /UPDATE accounts/.test(sql));
    expect(updateCall[1]).toEqual([
      'ep-bics-1', 'icc-1', 'LPA:1$thales3.prod.ondemandconnectivity.com$MATCH-1', baseRow.id,
    ]);
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

  it('auto-activates the account after provisioning (even when BICS fails)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // email pre-check
    didOrchestration.assignDid.mockResolvedValueOnce(credentials);
    crypto.hashPassword.mockResolvedValueOnce('hashed-pw');
    db.withTransaction.mockImplementationOnce(async (fn) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'pending' }] }) // INSERT account
          .mockResolvedValueOnce({ rows: [] }), // INSERT did
      };
      return fn(client);
    });
    // BICS best-effort fails — must still activate.
    bics.getNextAvailableEsim.mockRejectedValueOnce(
      Object.assign(new Error('pool'), { code: 'BICS_ERROR' }),
    );
    // transitionStatus('active'): getAccountById SELECT (pending) then UPDATE.
    db.query
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'pending' }] }) // getAccountById
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'active' }] }); // UPDATE RETURNING

    const result = await accountService.createAccount({ email: 'a@b.co', market: 'lewiston-id' });

    expect(result.status).toBe('active');
    expect(result.esim).toBeNull();
    expect(result.esim_error).toBe('BICS provisioning failed — retry from admin');
    // The activation UPDATE set status and stamped activated_at.
    const updateCall = db.query.mock.calls.find(
      ([sql]) => /UPDATE accounts/.test(sql) && /status = \$1/.test(sql) && /activated_at = NOW\(\)/.test(sql),
    );
    expect(updateCall).toBeTruthy();
  });

  it('accepts a non-launched area code: defaults market to "direct" and searches that area code', async () => {
    wireHappyPath();

    await accountService.createAccount({ email: 'a@b.co', phone_e164: '+13035550100' });

    // No market provided -> "direct"; area code derived from the chosen number.
    expect(didOrchestration.assignDid).toHaveBeenCalledWith('direct', '303', { firstName: null, lastName: null, serviceAddress: null });
  });

  it('routes a FOX promo code to gaiia + broadband fields on the account', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // email pre-check
    didOrchestration.assignDid.mockResolvedValueOnce(credentials);
    crypto.hashPassword.mockResolvedValueOnce('hashed-pw');
    let insertedParams;
    db.withTransaction.mockImplementationOnce(async (fn) => {
      const client = {
        query: jest.fn()
          .mockImplementationOnce((_sql, params) => {
            insertedParams = params;
            return { rows: [baseRow] };
          })
          .mockResolvedValueOnce({ rows: [] }), // INSERT did
      };
      return fn(client);
    });

    await accountService.createAccount({
      email: 'a@b.co', market: 'lewiston-id', promo_code: 'FOX-12345',
    });

    // INSERT params: ...$10 external_billing_provider, $11 broadband_provider,
    // $12 broadband_account_id, $13 promo_code.
    expect(insertedParams[9]).toBe('gaiia');
    expect(insertedParams[10]).toBe('fox');
    expect(insertedParams[11]).toBe('12345');
    expect(insertedParams[12]).toBe('FOX-12345');
  });

  it('defaults billing provider to telgoo5 with no promo code', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // email pre-check
    didOrchestration.assignDid.mockResolvedValueOnce(credentials);
    crypto.hashPassword.mockResolvedValueOnce('hashed-pw');
    let insertedParams;
    db.withTransaction.mockImplementationOnce(async (fn) => {
      const client = {
        query: jest.fn()
          .mockImplementationOnce((_sql, params) => {
            insertedParams = params;
            return { rows: [baseRow] };
          })
          .mockResolvedValueOnce({ rows: [] }),
      };
      return fn(client);
    });

    await accountService.createAccount({ email: 'a@b.co', market: 'lewiston-id' });

    expect(insertedParams[9]).toBe('telgoo5');
    expect(insertedParams[10]).toBeNull(); // broadband_provider
    expect(insertedParams[11]).toBeNull(); // broadband_account_id
    expect(insertedParams[12]).toBeNull(); // promo_code
  });

  it('persists enrollment fields (name + normalized addresses)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // email pre-check
    didOrchestration.assignDid.mockResolvedValueOnce(credentials);
    crypto.hashPassword.mockResolvedValueOnce('hashed-pw');
    let insertedParams;
    db.withTransaction.mockImplementationOnce(async (fn) => {
      const client = {
        query: jest.fn()
          .mockImplementationOnce((_sql, params) => {
            insertedParams = params;
            return { rows: [baseRow] };
          })
          .mockResolvedValueOnce({ rows: [] }),
      };
      return fn(client);
    });

    await accountService.createAccount({
      email: 'a@b.co',
      market: 'lewiston-id',
      first_name: 'Jane',
      last_name: 'Doe',
      service_address: {
        line1: '1 Main', line2: 'Apt 2', city: 'Lewiston', state: 'ID', zip: '83501',
      },
      billing_address: {
        line1: '2 Oak', city: 'Boise', state: 'ID', zip: '83702',
      },
    });

    // INSERT params: ...$14 first_name, $15 last_name, $16 service_address, $17 billing_address.
    expect(insertedParams[13]).toBe('Jane');
    expect(insertedParams[14]).toBe('Doe');
    expect(insertedParams[15]).toEqual({
      line1: '1 Main', line2: 'Apt 2', city: 'Lewiston', state: 'ID', zip: '83501',
    });
    // line2 absent → normalized to null.
    expect(insertedParams[16]).toEqual({
      line1: '2 Oak', line2: null, city: 'Boise', state: 'ID', zip: '83702',
    });
    // $18 e911_address_id, $19 e911_enabled — from the assignDid credentials.
    expect(insertedParams[17]).toBe('addr-9');
    expect(insertedParams[18]).toBe(true);
    // $20 tenant_id — defaults to the MobilityNet tenant when none is supplied.
    expect(insertedParams[19]).toBe('00000000-0000-4000-a000-000000000001');

    // E911 enrollment context flows through to assignDid.
    expect(didOrchestration.assignDid).toHaveBeenCalledWith('lewiston-id', null, {
      firstName: 'Jane',
      lastName: 'Doe',
      serviceAddress: {
        line1: '1 Main', line2: 'Apt 2', city: 'Lewiston', state: 'ID', zip: '83501',
      },
    });
  });

  it('rejects a non-object service_address', async () => {
    await expect(accountService.createAccount({
      email: 'a@b.co', market: 'lewiston-id', service_address: 'not-an-object',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'service_address' });
    expect(didOrchestration.assignDid).not.toHaveBeenCalled();
  });

  it('triggers a best-effort Telgoo5 sync for an active telgoo5 account with enrollment details', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // email pre-check
    didOrchestration.assignDid.mockResolvedValueOnce(credentials);
    crypto.hashPassword.mockResolvedValueOnce('hashed-pw');
    db.withTransaction.mockImplementationOnce(async (fn) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'pending' }] }) // INSERT account
          .mockResolvedValueOnce({ rows: [] }), // INSERT did
      };
      return fn(client);
    });
    // BICS best-effort fails — irrelevant to the sync.
    bics.getNextAvailableEsim.mockRejectedValueOnce(
      Object.assign(new Error('pool'), { code: 'BICS_ERROR' }),
    );
    // auto-activation succeeds.
    db.query
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'pending' }] }) // getAccountById
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'active' }] }); // UPDATE
    telgoo5Service.syncAccountToTelgoo5.mockResolvedValueOnce({ synced: true });

    await accountService.createAccount({
      email: 'a@b.co',
      market: 'lewiston-id',
      first_name: 'Jane',
      last_name: 'Doe',
      service_address: {
        line1: '1 Main', city: 'Lewiston', state: 'ID', zip: '83501',
      },
    });

    expect(telgoo5Service.syncAccountToTelgoo5).toHaveBeenCalledWith(baseRow.id, {
      firstName: 'Jane',
      lastName: 'Doe',
      serviceAddress: {
        line1: '1 Main', line2: null, city: 'Lewiston', state: 'ID', zip: '83501',
      },
      billingAddress: null,
    });
  });

  it('does NOT trigger Telgoo5 sync for a gaiia (promo) account', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // email pre-check
    didOrchestration.assignDid.mockResolvedValueOnce(credentials);
    crypto.hashPassword.mockResolvedValueOnce('hashed-pw');
    db.withTransaction.mockImplementationOnce(async (fn) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'pending' }] })
          .mockResolvedValueOnce({ rows: [] }),
      };
      return fn(client);
    });
    bics.getNextAvailableEsim.mockRejectedValueOnce(
      Object.assign(new Error('pool'), { code: 'BICS_ERROR' }),
    );
    db.query
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ ...baseRow, status: 'active' }] });

    await accountService.createAccount({
      email: 'a@b.co',
      market: 'lewiston-id',
      promo_code: 'FOX-1',
      first_name: 'Jane',
      service_address: {
        line1: '1 Main', city: 'Lewiston', state: 'ID', zip: '83501',
      },
    });

    expect(telgoo5Service.syncAccountToTelgoo5).not.toHaveBeenCalled();
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
    expect(updateCall[1]).toEqual([
      'ep-bics-1', 'icc-1', 'LPA:1$thales3.prod.ondemandconnectivity.com$MATCH-1', baseRow.id,
    ]);
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
    expect(didOrchestration.assignDid).toHaveBeenCalledWith('lewiston-id', null, { firstName: null, lastName: null, serviceAddress: null });
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

describe('getEsimQr', () => {
  const LPA = 'LPA:1$thales3.prod.ondemandconnectivity.com$MATCH-1';

  it('renders the QR from a stored activation code (increments the download count)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        ...baseRow,
        bics_endpoint_id: 'ep-bics-1',
        bics_iccid: 'icc-1',
        esim_activation_code: LPA,
        esim_download_count: 1,
      }],
    });
    const result = await accountService.getEsimQr(baseRow.id);
    expect(result.qr_code_url).toMatch(/^data:image\/png;base64,/);
    expect(result.iccid).toBe('icc-1');
    expect(result.endpoint_id).toBe('ep-bics-1');
    expect(result.activation_code).toBe(LPA);
    // Reuse — no BICS calls — but the download counter is bumped (now 2 of 3).
    expect(bics.fetchSimByIccid).not.toHaveBeenCalled();
    expect(bics.getNextAvailableEsim).not.toHaveBeenCalled();
    const inc = db.query.mock.calls.find(([sql]) => /esim_download_count = \$1/.test(sql));
    expect(inc[1]).toEqual([2, baseRow.id]);
  });

  it('forces a fresh BICS endpoint on the 3rd download instead of reusing', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          ...baseRow,
          bics_endpoint_id: 'ep-old',
          bics_iccid: 'icc-old',
          esim_activation_code: 'LPA:old',
          esim_download_count: 2,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ ...baseRow, bics_endpoint_id: 'ep-new' }] }); // persistEsim
    wireBicsSuccess('icc-new', 'ep-new');
    const result = await accountService.getEsimQr(baseRow.id);
    // Count would reach 3 → regenerate a new eSIM, do NOT reuse the old code.
    expect(bics.getNextAvailableEsim).toHaveBeenCalled();
    expect(result.endpoint_id).toBe('ep-new');
    // It regenerated rather than doing a plain download-count increment.
    const inc = db.query.mock.calls.find(([sql]) => /SET esim_download_count = \$1/.test(sql));
    expect(inc).toBeUndefined();
  });

  it('reads the code live from BICS when an endpoint exists but no code is stored', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          ...baseRow, bics_endpoint_id: 'ep-bics-1', bics_iccid: 'icc-1', esim_activation_code: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE esim_activation_code
    bics.fetchSimByIccid.mockResolvedValueOnce({
      endPointId: 'ep-bics-1',
      activationCode: { textQrCode: LPA, smDpPlusAdress: 'thales3.prod.ondemandconnectivity.com' },
    });
    const result = await accountService.getEsimQr(baseRow.id);
    expect(bics.fetchSimByIccid).toHaveBeenCalledWith('icc-1');
    expect(result.activation_code).toBe(LPA);
    expect(result.sm_dp_address).toBe('thales3.prod.ondemandconnectivity.com');
    // Persisted the code for next time.
    const upd = db.query.mock.calls.find(([sql]) => /SET esim_activation_code/.test(sql));
    expect(upd[1]).toEqual([LPA, baseRow.id]);
  });

  it('provisions a fresh BICS endpoint when none exists', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ ...baseRow, bics_endpoint_id: null }] }) // load
      .mockResolvedValueOnce({ rows: [{ ...baseRow, bics_endpoint_id: 'ep-bics-1' }] }); // persistEsim
    wireBicsSuccess('icc-1', 'ep-bics-1');
    const result = await accountService.getEsimQr(baseRow.id);
    expect(bics.getNextAvailableEsim).toHaveBeenCalled();
    expect(result.iccid).toBe('icc-1');
    expect(result.endpoint_id).toBe('ep-bics-1');
    expect(result.qr_code_url).toMatch(/^data:image\/png;base64,/);
    // persistEsim writes bics + legacy esim_iccid + activation code.
    const upd = db.query.mock.calls.find(([sql]) => /esim_activation_code = \$3/.test(sql));
    expect(upd[1]).toEqual(['ep-bics-1', 'icc-1', LPA, baseRow.id]);
  });

  it('regenerate=true provisions a new endpoint even when one already exists', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          ...baseRow, bics_endpoint_id: 'ep-old', bics_iccid: 'icc-old', esim_activation_code: 'LPA:old',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ ...baseRow, bics_endpoint_id: 'ep-new' }] }); // persistEsim
    wireBicsSuccess('icc-new', 'ep-new');
    const result = await accountService.getEsimQr(baseRow.id, { regenerate: true });
    expect(bics.getNextAvailableEsim).toHaveBeenCalled();
    expect(result.iccid).toBe('icc-new');
    expect(result.endpoint_id).toBe('ep-new');
  });

  it('throws NOT_FOUND when the account does not exist', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(accountService.getEsimQr(baseRow.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('refreshSipPasswordHash', () => {
  it('fetches the live SIP password, hashes it, and persists the hash', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [baseRow] }) // getAccountById
      .mockResolvedValueOnce({}); // UPDATE sip_password_hash
    didOrchestration.getSipPassword.mockResolvedValueOnce('live-sip-pw');
    crypto.hashPassword.mockResolvedValueOnce('bcrypt$new');

    const result = await accountService.refreshSipPasswordHash(baseRow.id);

    expect(result).toEqual({ updated: true });
    expect(didOrchestration.getSipPassword).toHaveBeenCalledWith(baseRow.sip_endpoint_id);
    expect(crypto.hashPassword).toHaveBeenCalledWith('live-sip-pw');
    // The UPDATE persists the new hash for the account.
    const updateCall = db.query.mock.calls.find(([sql]) => /UPDATE accounts SET sip_password_hash/.test(sql));
    expect(updateCall[1]).toEqual(['bcrypt$new', baseRow.id]);
  });

  it('404s when the account does not exist', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(accountService.refreshSipPasswordHash(baseRow.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(didOrchestration.getSipPassword).not.toHaveBeenCalled();
  });

  it('rejects an account with no SIP endpoint', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...baseRow, sip_endpoint_id: null }] });
    await expect(accountService.refreshSipPasswordHash(baseRow.id))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'sip_endpoint_id' });
    expect(didOrchestration.getSipPassword).not.toHaveBeenCalled();
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

  it('updates first_name, last_name, and email (trimmed/normalized)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [baseRow] }) // current
      .mockResolvedValueOnce({ rows: [{ ...baseRow, first_name: 'Jane', last_name: 'Doe' }] });
    const result = await accountService.updateAccount(baseRow.id, {
      first_name: '  Jane  ', last_name: 'Doe', email: 'JANE@Example.com ',
    });
    const [sql, values] = db.query.mock.calls[1];
    expect(sql).toMatch(/email = \$/);
    expect(sql).toMatch(/first_name = \$/);
    expect(sql).toMatch(/last_name = \$/);
    // Name trimmed; email lowercased/trimmed.
    expect(values).toContain('Jane');
    expect(values).toContain('Doe');
    expect(values).toContain('jane@example.com');
    expect(result.first_name).toBe('Jane');
  });

  it('rejects a duplicate email with a 409 conflict', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [baseRow] }) // current
      .mockRejectedValueOnce({ code: '23505' }); // unique violation
    await expect(accountService.updateAccount(baseRow.id, { email: 'taken@example.com' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'email', status: 409 });
  });

  it('updates sip_username and sip_endpoint_id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [baseRow] }) // current
      .mockResolvedValueOnce({ rows: [{ ...baseRow, sip_username: 'u2', sip_endpoint_id: 'ep2' }] });
    const result = await accountService.updateAccount(baseRow.id, {
      sip_username: 'u2', sip_endpoint_id: 'ep2',
    });
    const [sql, values] = db.query.mock.calls[1];
    expect(sql).toMatch(/sip_username = \$1/);
    expect(sql).toMatch(/sip_endpoint_id = \$2/);
    expect(values).toEqual(['u2', 'ep2', baseRow.id]);
    expect(result.sip_username).toBe('u2');
  });
});

describe('serializeAccount', () => {
  it('strips the password hash', () => {
    expect(accountService.serializeAccount(baseRow)).not.toHaveProperty('sip_password_hash');
  });
  it('passes through null', () => {
    expect(accountService.serializeAccount(null)).toBeNull();
  });
  it('passes through billing/broadband/promo, telgoo5, and enrollment fields', () => {
    const row = {
      ...baseRow,
      external_billing_provider: 'gaiia',
      broadband_provider: 'fox',
      broadband_account_id: '99',
      promo_code: 'FOX-99',
      telgoo5_customer_id: 'C1',
      telgoo5_enrollment_id: 'E1',
      first_name: 'Jane',
      last_name: 'Doe',
      service_address: {
        line1: '1 Main', city: 'Lewiston', state: 'ID', zip: '83501',
      },
      billing_address: {
        line1: '2 Oak', city: 'Boise', state: 'ID', zip: '83702',
      },
    };
    const result = accountService.serializeAccount(row);
    expect(result).toMatchObject({
      external_billing_provider: 'gaiia',
      broadband_provider: 'fox',
      broadband_account_id: '99',
      promo_code: 'FOX-99',
      telgoo5_customer_id: 'C1',
      telgoo5_enrollment_id: 'E1',
      first_name: 'Jane',
      last_name: 'Doe',
      service_address: {
        line1: '1 Main', city: 'Lewiston', state: 'ID', zip: '83501',
      },
      billing_address: {
        line1: '2 Oak', city: 'Boise', state: 'ID', zip: '83702',
      },
    });
    expect(result).not.toHaveProperty('sip_password_hash');
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
