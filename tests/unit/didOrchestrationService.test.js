jest.mock('../../src/integrations/telnyx');
jest.mock('../../src/utils/crypto');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  REDACT_PATHS: [],
}));

const telnyx = require('../../src/integrations/telnyx');
const { logger } = require('../../src/utils/logger');
const crypto = require('../../src/utils/crypto');
const did = require('../../src/services/didOrchestrationService');

beforeEach(() => {
  jest.clearAllMocks();
  crypto.randomSecret.mockReturnValue('generated-pw');
});

describe('assignDid', () => {
  it('runs search -> purchase -> create endpoint -> assign and returns credentials', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValueOnce([{ number: '+12085550100' }]);
    telnyx.purchaseNumber.mockResolvedValueOnce({ id: 'sid-1' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({ id: 'ep-1' });
    telnyx.assignNumberToEndpoint.mockResolvedValueOnce({});

    const cred = await did.assignDid('lewiston-id');

    expect(cred).toMatchObject({
      phoneE164: '+12085550100',
      areaCode: '208',
      signalwireSid: 'sid-1',
      sipEndpointId: 'ep-1',
      sipPassword: 'generated-pw',
    });
    expect(cred.sipUsername).toMatch(/^pivottech-/);
    expect(telnyx.createSipEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ callerId: '+12085550100', password: 'generated-pw' }),
    );
    expect(telnyx.assignNumberToEndpoint).toHaveBeenCalledWith('sid-1', 'ep-1');
  });

  it('throws VALIDATION_ERROR for an unknown market', async () => {
    await expect(did.assignDid('atlantis')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(telnyx.searchAvailableNumbers).not.toHaveBeenCalled();
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
    telnyx.purchaseNumber.mockResolvedValueOnce({ id: 'sid-3' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({ id: 'ep-3' });
    telnyx.assignNumberToEndpoint.mockResolvedValueOnce({});

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
    telnyx.purchaseNumber.mockResolvedValueOnce({ id: 'sid-2' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({ id: 'ep-2' });
    telnyx.assignNumberToEndpoint.mockResolvedValueOnce({});

    const cred = await did.assignDid('kendall-il');
    expect(cred.areaCode).toBe('331');
    expect(cred.phoneE164).toBe('+13315550100');
  });
});

describe('rotateSipPassword', () => {
  it('generates a new password and pushes it to the endpoint', async () => {
    crypto.randomSecret.mockReturnValueOnce('new-pw');
    telnyx.updateSipEndpoint.mockResolvedValueOnce({});
    const pw = await did.rotateSipPassword('ep-1');
    expect(pw).toBe('new-pw');
    expect(telnyx.updateSipEndpoint).toHaveBeenCalledWith('ep-1', { password: 'new-pw' });
  });
});
