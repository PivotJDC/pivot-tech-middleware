jest.mock('../../src/integrations/signalwire');
jest.mock('../../src/utils/crypto');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  REDACT_PATHS: [],
}));

const signalwire = require('../../src/integrations/signalwire');
const { logger } = require('../../src/utils/logger');
const crypto = require('../../src/utils/crypto');
const did = require('../../src/services/didOrchestrationService');

beforeEach(() => {
  jest.clearAllMocks();
  crypto.randomSecret.mockReturnValue('generated-pw');
});

describe('assignDid', () => {
  it('runs search -> purchase -> create endpoint -> assign and returns credentials', async () => {
    signalwire.searchAvailableNumbers.mockResolvedValueOnce([{ number: '+12085550100' }]);
    signalwire.purchaseNumber.mockResolvedValueOnce({ id: 'sid-1' });
    signalwire.createSipEndpoint.mockResolvedValueOnce({ id: 'ep-1' });
    signalwire.assignNumberToEndpoint.mockResolvedValueOnce({});

    const cred = await did.assignDid('lewiston-id');

    expect(cred).toMatchObject({
      phoneE164: '+12085550100',
      areaCode: '208',
      signalwireSid: 'sid-1',
      sipEndpointId: 'ep-1',
      sipPassword: 'generated-pw',
    });
    expect(cred.sipUsername).toMatch(/^pivottech-/);
    expect(signalwire.createSipEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ callerId: '+12085550100', password: 'generated-pw' }),
    );
    expect(signalwire.assignNumberToEndpoint).toHaveBeenCalledWith('sid-1', 'ep-1');
  });

  it('throws VALIDATION_ERROR for an unknown market', async () => {
    await expect(did.assignDid('atlantis')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(signalwire.searchAvailableNumbers).not.toHaveBeenCalled();
  });

  it('tries each area code and throws DID_UNAVAILABLE when none have numbers', async () => {
    signalwire.searchAvailableNumbers.mockResolvedValue([]); // both 630 and 331 empty
    await expect(did.assignDid('kendall-il')).rejects.toMatchObject({ code: 'DID_UNAVAILABLE' });
    expect(signalwire.searchAvailableNumbers).toHaveBeenCalledTimes(2);
  });

  it('logs a DID_UNAVAILABLE error naming every area code tried on exhaustion', async () => {
    signalwire.searchAvailableNumbers.mockResolvedValue([]);
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
    signalwire.searchAvailableNumbers
      .mockResolvedValueOnce([]) // 630 empty
      .mockResolvedValueOnce([{ number: '+13315550100' }]); // 331 has one
    signalwire.purchaseNumber.mockResolvedValueOnce({ id: 'sid-3' });
    signalwire.createSipEndpoint.mockResolvedValueOnce({ id: 'ep-3' });
    signalwire.assignNumberToEndpoint.mockResolvedValueOnce({});

    await did.assignDid('kendall-il');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ market: 'kendall-il', areaCode: '331', exhausted: ['630'] }),
      expect.stringContaining('using fallback 331'),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('falls through to the second area code when the first is empty', async () => {
    signalwire.searchAvailableNumbers
      .mockResolvedValueOnce([]) // 630 empty
      .mockResolvedValueOnce([{ number: '+13315550100' }]); // 331 has one
    signalwire.purchaseNumber.mockResolvedValueOnce({ id: 'sid-2' });
    signalwire.createSipEndpoint.mockResolvedValueOnce({ id: 'ep-2' });
    signalwire.assignNumberToEndpoint.mockResolvedValueOnce({});

    const cred = await did.assignDid('kendall-il');
    expect(cred.areaCode).toBe('331');
    expect(cred.phoneE164).toBe('+13315550100');
  });
});

describe('rotateSipPassword', () => {
  it('generates a new password and pushes it to the endpoint', async () => {
    crypto.randomSecret.mockReturnValueOnce('new-pw');
    signalwire.updateSipEndpoint.mockResolvedValueOnce({});
    const pw = await did.rotateSipPassword('ep-1');
    expect(pw).toBe('new-pw');
    expect(signalwire.updateSipEndpoint).toHaveBeenCalledWith('ep-1', { password: 'new-pw' });
  });
});
