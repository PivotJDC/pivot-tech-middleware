jest.mock('../../src/db');
jest.mock('../../src/config', () => ({
  provisioning: { baseUrl: 'https://api.pivot-tech.io', tokenTtlHours: 72 },
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
  it('stores the token hash and returns raw token + links', async () => {
    token.generateProvisioningToken.mockReturnValue('raw-token');
    token.hashProvisioningToken.mockReturnValue('hash');
    db.query.mockResolvedValueOnce({ rows: [{ expires_at: '2026-06-08T00:00:00Z' }] });

    const result = await provisioning.issueToken(account);

    expect(db.query.mock.calls[0][1]).toEqual(['acc-1', 'hash', 72]);
    expect(result.raw_token).toBe('raw-token');
    expect(result.provisioning_url).toBe('https://api.pivot-tech.io/v1/provision?token=raw-token');
    expect(result.qr_code_data).toContain('token=raw-token');
    expect(result.deep_link).toContain('token=raw-token');
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
  it('rotates the SIP password, persists the hash, and builds XML', async () => {
    didOrchestration.rotateSipPassword.mockResolvedValueOnce('new-pw');
    crypto.hashPassword.mockResolvedValueOnce('new-hash');
    accountService.setSipPasswordHash.mockResolvedValueOnce();
    acrobits.buildAccountXml.mockReturnValueOnce('<account/>');

    const xml = await provisioning.generateAccountXml(account);

    expect(xml).toBe('<account/>');
    expect(didOrchestration.rotateSipPassword).toHaveBeenCalledWith('ep-1');
    expect(accountService.setSipPasswordHash).toHaveBeenCalledWith('acc-1', 'new-hash');
    expect(acrobits.buildAccountXml).toHaveBeenCalledWith({
      sipUsername: 'pivottech-abc',
      sipPassword: 'new-pw',
      phoneE164: '+12085550100',
    });
  });

  it('throws INTERNAL_ERROR when the account has no SIP endpoint', async () => {
    await expect(provisioning.generateAccountXml({ id: 'acc-1' }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(didOrchestration.rotateSipPassword).not.toHaveBeenCalled();
  });
});

describe('provisionByToken', () => {
  it('consumes the token, loads the account, and returns XML', async () => {
    token.hashProvisioningToken.mockReturnValue('hash');
    db.query.mockResolvedValueOnce({ rows: [{ account_id: 'acc-1' }] }); // consume
    accountService.getAccountById.mockResolvedValueOnce(account);
    didOrchestration.rotateSipPassword.mockResolvedValueOnce('new-pw');
    crypto.hashPassword.mockResolvedValueOnce('new-hash');
    accountService.setSipPasswordHash.mockResolvedValueOnce();
    acrobits.buildAccountXml.mockReturnValueOnce('<account/>');

    const xml = await provisioning.provisionByToken('raw-token');
    expect(xml).toBe('<account/>');
    expect(accountService.getAccountById).toHaveBeenCalledWith('acc-1');
  });
});

describe('reissueToken', () => {
  it('validates the account then issues a fresh token', async () => {
    accountService.getAccountById.mockResolvedValueOnce(account);
    token.generateProvisioningToken.mockReturnValue('raw-2');
    token.hashProvisioningToken.mockReturnValue('hash-2');
    db.query.mockResolvedValueOnce({ rows: [{ expires_at: 'x' }] });

    const result = await provisioning.reissueToken('acc-1');
    expect(accountService.getAccountById).toHaveBeenCalledWith('acc-1');
    expect(result.raw_token).toBe('raw-2');
  });
});
