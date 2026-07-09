jest.mock('../../src/db');
jest.mock('../../src/config', () => ({
  provisioning: { baseUrl: 'https://api.pivot-tech.io', tokenTtlHours: 72 },
  acrobits: { cloudId: '54873' },
}));
jest.mock('../../src/utils/token');
jest.mock('../../src/utils/crypto');
jest.mock('../../src/integrations/acrobits');
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/didOrchestrationService');

const db = require('../../src/db');
const token = require('../../src/utils/token');
const crypto = require('../../src/utils/crypto');
const acrobits = require('../../src/integrations/acrobits');
const accountService = require('../../src/services/accountService');
const didOrchestration = require('../../src/services/didOrchestrationService');
const provisioning = require('../../src/services/provisioningService');

const account = {
  id: 'acc-1',
  sip_username: 'pivottech-abc',
  sip_endpoint_id: 'ep-1',
  phone_e164: '+12085550100',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('issueToken', () => {
  beforeEach(() => {
    token.generateProvisioningToken.mockReturnValue('raw-token');
    token.hashProvisioningToken.mockReturnValue('hash');
    didOrchestration.getSipPassword.mockResolvedValue('qr-pw');
    crypto.hashPassword.mockResolvedValue('qr-hash');
    accountService.setSipPasswordHash.mockResolvedValue();
  });

  it('stores the token hash and returns raw token + links', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ expires_at: '2026-06-08T00:00:00Z' }] });

    const result = await provisioning.issueToken(account);

    expect(db.query.mock.calls[0][1]).toEqual(['acc-1', 'hash', 72]);
    expect(result.raw_token).toBe('raw-token');
    expect(result.provisioning_url).toBe('https://api.pivot-tech.io/v1/provision?token=raw-token');
    expect(result.qr_code_url).toMatch(/^data:image\/png;base64,/);
  });

  it('builds the QR and deep link from the Acrobits csc: URI with the fetched SIP creds', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ expires_at: '2026-06-08T00:00:00Z' }] });

    const result = await provisioning.issueToken(account);

    expect(result.deep_link).toBe('csc:pivottech-abc:qr-pw@54873');
    expect(didOrchestration.getSipPassword).toHaveBeenCalledWith('ep-1');
    // Telnyx credentials are immutable: nothing is re-persisted at issuance.
    expect(accountService.setSipPasswordHash).not.toHaveBeenCalled();
    // provisioning_url keeps the token flow — csc: is QR/deep-link only.
    expect(result.provisioning_url).toContain('token=raw-token');
  });

  it('throws INTERNAL_ERROR (no token row, no rotation) when SIP setup is incomplete', async () => {
    await expect(provisioning.issueToken({ id: 'acc-1' }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(db.query).not.toHaveBeenCalled();
    expect(didOrchestration.getSipPassword).not.toHaveBeenCalled();
  });
});

describe('validateAndConsumeToken', () => {
  it('atomically consumes a valid token and returns the account id', async () => {
    token.hashProvisioningToken.mockReturnValue('hash');
    db.query.mockResolvedValueOnce({ rows: [{ account_id: 'acc-1' }] });

    const id = await provisioning.validateAndConsumeToken('raw-token');
    expect(id).toBe('acc-1');
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/SET used = TRUE/);
    expect(sql).toMatch(/used = FALSE AND expires_at > NOW\(\)/);
  });

  it('throws TOKEN_EXPIRED when the token is missing/used/expired', async () => {
    token.hashProvisioningToken.mockReturnValue('hash');
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(provisioning.validateAndConsumeToken('raw-token'))
      .rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
  });

  it('throws VALIDATION_ERROR for a missing token', async () => {
    await expect(provisioning.validateAndConsumeToken(''))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('generateAccountXml', () => {
  it('fetches the SIP password (no rotation) and builds XML with the Telnyx creds', async () => {
    didOrchestration.getSipPassword.mockResolvedValueOnce('new-pw');
    acrobits.buildAccountXml.mockReturnValueOnce('<account/>');

    const xml = await provisioning.generateAccountXml(account);

    expect(xml).toBe('<account/>');
    expect(didOrchestration.getSipPassword).toHaveBeenCalledWith('ep-1');
    // Immutable Telnyx credential — no re-hash/persist on the provisioning path.
    expect(accountService.setSipPasswordHash).not.toHaveBeenCalled();
    expect(acrobits.buildAccountXml).toHaveBeenCalledWith({
      sipUsername: 'pivottech-abc',
      sipPassword: 'new-pw',
      phoneE164: '+12085550100',
    });
  });

  it('throws INTERNAL_ERROR when the account has no SIP endpoint', async () => {
    await expect(provisioning.generateAccountXml({ id: 'acc-1' }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(didOrchestration.getSipPassword).not.toHaveBeenCalled();
  });
});

describe('provisionByToken', () => {
  it('consumes the token, loads the account, and returns XML', async () => {
    token.hashProvisioningToken.mockReturnValue('hash');
    db.query.mockResolvedValueOnce({ rows: [{ account_id: 'acc-1' }] }); // consume
    accountService.getAccountById.mockResolvedValueOnce(account);
    didOrchestration.getSipPassword.mockResolvedValueOnce('new-pw');
    crypto.hashPassword.mockResolvedValueOnce('new-hash');
    accountService.setSipPasswordHash.mockResolvedValueOnce();
    acrobits.buildAccountXml.mockReturnValueOnce('<account/>');

    const xml = await provisioning.provisionByToken('raw-token');
    expect(xml).toBe('<account/>');
    expect(accountService.getAccountById).toHaveBeenCalledWith('acc-1');
  });
});

describe('buildProvisioningQr', () => {
  it('reads the live gencred + password and builds the csc: QR (no stored sip_username)', async () => {
    didOrchestration.getSipCredential.mockResolvedValueOnce({
      sip_username: 'gencred-live', sip_password: 's3cr3t/pw+1',
    });

    const result = await provisioning.buildProvisioningQr(account);

    // config.acrobits.cloudId is mocked to '54873'; both parts come from the
    // live GET, so a stale account.sip_username is never used.
    expect(result.provisioning_url).toBe('csc:gencred-live:s3cr3t%2Fpw%2B1@54873');
    expect(result.qr_url).toMatch(/^data:image\/png;base64,/);
    expect(didOrchestration.getSipCredential).toHaveBeenCalledWith('ep-1');
  });

  it('throws when the account has no SIP endpoint yet', async () => {
    await expect(provisioning.buildProvisioningQr({ id: 'a1' }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(didOrchestration.getSipCredential).not.toHaveBeenCalled();
  });
});

describe('reissueToken', () => {
  it('validates the account then issues a fresh token', async () => {
    accountService.getAccountById.mockResolvedValueOnce(account);
    token.generateProvisioningToken.mockReturnValue('raw-2');
    token.hashProvisioningToken.mockReturnValue('hash-2');
    didOrchestration.getSipPassword.mockResolvedValue('qr-pw');
    crypto.hashPassword.mockResolvedValue('qr-hash');
    accountService.setSipPasswordHash.mockResolvedValue();
    db.query.mockResolvedValueOnce({ rows: [{ expires_at: 'x' }] });

    const result = await provisioning.reissueToken('acc-1');
    expect(accountService.getAccountById).toHaveBeenCalledWith('acc-1');
    expect(result.raw_token).toBe('raw-2');
  });
});
