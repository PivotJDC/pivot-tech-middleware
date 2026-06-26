jest.mock('../../src/integrations/telnyx');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  REDACT_PATHS: [],
}));

const telnyx = require('../../src/integrations/telnyx');
const { logger } = require('../../src/utils/logger');
const did = require('../../src/services/didOrchestrationService');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('assignDid', () => {
  it('runs search -> purchase -> create endpoint -> assign and returns Telnyx credentials', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValueOnce([{ number: '+12085550100' }]);
    telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-1' });
    // Telnyx auto-generates the real sip_username/sip_password.
    telnyx.createSipEndpoint.mockResolvedValueOnce({
      id: 'ep-1', sip_username: 'telnyx-user-1', sip_password: 'telnyx-pw-1',
    });

    const cred = await did.assignDid('lewiston-id');

    expect(cred).toMatchObject({
      phoneE164: '+12085550100',
      areaCode: '208',
      signalwireSid: 'sid-1',
      sipEndpointId: 'ep-1',
      // The account uses Telnyx's returned credentials, not self-generated ones.
      sipUsername: 'telnyx-user-1',
      sipPassword: 'telnyx-pw-1',
    });
    // We still pass a recognizable credential name, but never a password (Telnyx generates it).
    expect(telnyx.createSipEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ callerId: '+12085550100' }),
    );
    expect(telnyx.createSipEndpoint.mock.calls[0][0].username).toMatch(/^pivottech-/);
    expect(telnyx.createSipEndpoint.mock.calls[0][0]).not.toHaveProperty('password');
    // The number's connection_id stays on the TeXML app (set by
    // provisionPhoneNumber); we must NOT reassign it to the SIP connection.
    expect(telnyx.assignNumberToEndpoint).not.toHaveBeenCalled();
  });

  it('throws VALIDATION_ERROR for an unknown market with no requested area code', async () => {
    await expect(did.assignDid('atlantis')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(telnyx.searchAvailableNumbers).not.toHaveBeenCalled();
  });

  it('searches the requested area code for a "direct"/unlaunched market (e.g. 303)', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValueOnce([{ number: '+13035550100' }]);
    telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-303' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({
      id: 'ep-303', sip_username: 'u-303', sip_password: 'p-303',
    });

    const cred = await did.assignDid('direct', '303');

    expect(telnyx.searchAvailableNumbers).toHaveBeenCalledWith('303');
    expect(cred.areaCode).toBe('303');
    expect(cred.phoneE164).toBe('+13035550100');
  });

  it('tries each area code and throws DID_UNAVAILABLE when none have numbers', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValue([]); // both 630 and 331 empty
    await expect(did.assignDid('kendall-il')).rejects.toMatchObject({ code: 'DID_UNAVAILABLE' });
    expect(telnyx.searchAvailableNumbers).toHaveBeenCalledTimes(2);
  });

  it('logs a DID_UNAVAILABLE error naming every area code tried on exhaustion', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValue([]);
    await expect(did.assignDid('kendall-il')).rejects.toMatchObject({ code: 'DID_UNAVAILABLE' });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'DID_UNAVAILABLE',
        market: 'kendall-il',
        areaCodesTried: ['630', '331'],
      }),
      expect.stringContaining('630, 331'),
    );
  });

  it('logs a fallback warning when the primary area code is empty but a later one hits', async () => {
    telnyx.searchAvailableNumbers
      .mockResolvedValueOnce([]) // 630 empty
      .mockResolvedValueOnce([{ number: '+13315550100' }]); // 331 has one
    telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-3' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({ id: 'ep-3' });

    await did.assignDid('kendall-il');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ market: 'kendall-il', areaCode: '331', exhausted: ['630'] }),
      expect.stringContaining('using fallback 331'),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('falls through to the second area code when the first is empty', async () => {
    telnyx.searchAvailableNumbers
      .mockResolvedValueOnce([]) // 630 empty
      .mockResolvedValueOnce([{ number: '+13315550100' }]); // 331 has one
    telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-2' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({ id: 'ep-2' });

    const cred = await did.assignDid('kendall-il');
    expect(cred.areaCode).toBe('331');
    expect(cred.phoneE164).toBe('+13315550100');
  });
});

describe('getSipPassword', () => {
  it('fetches the existing Telnyx credential and returns its current password', async () => {
    telnyx.getSipEndpoint.mockResolvedValueOnce({ sip_username: 'telnyx-user-1', sip_password: 'telnyx-pw-1' });
    const pw = await did.getSipPassword('ep-1');
    expect(pw).toBe('telnyx-pw-1');
    expect(telnyx.getSipEndpoint).toHaveBeenCalledWith('ep-1');
    // Telnyx can't rotate credential passwords — make sure we don't try.
    expect(telnyx.updateSipEndpoint).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
