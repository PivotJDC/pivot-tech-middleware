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
      // The subscriber's E.164 IS the SIP username (no gencred); only the
      // password comes from Telnyx.
      sipUsername: '+12085550100',
      sipPassword: 'telnyx-pw-1',
    });
    // The credential is created with the E.164 as its username; never a password
    // (Telnyx generates it).
    expect(telnyx.createSipEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ username: '+12085550100', callerId: '+12085550100' }),
    );
    expect(telnyx.createSipEndpoint.mock.calls[0][0]).not.toHaveProperty('password');
    // The number's connection_id stays on the TeXML app (set by
    // provisionPhoneNumber); we must NOT reassign it to the SIP connection.
    expect(telnyx.assignNumberToEndpoint).not.toHaveBeenCalled();
    // CNAM registered with the brand fallback when there's no subscriber name.
    expect(telnyx.updatePhoneNumber).toHaveBeenCalledWith('+12085550100', {
      cnam_listing_enabled: true,
      caller_id_name_as: 'MobilityNet',
    });
    // The DID is authorized for outbound SIP via the outbound voice profile.
    expect(telnyx.updatePhoneNumber).toHaveBeenCalledWith('+12085550100', {
      outbound_voice_profile_id: '2999700951977165829',
    });
  });

  it('provisions E911 (best-effort) when an enrollment serviceAddress is supplied', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValueOnce([{ number: '+12085550100' }]);
    telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-1' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({
      id: 'ep-1', sip_username: 'u', sip_password: 'p',
    });
    telnyx.createE911Address.mockResolvedValueOnce({ addressId: 'addr-9', status: 'pending' });
    telnyx.enableE911.mockResolvedValueOnce({ emergencyEnabled: true, emergencyStatus: 'enabled' });

    const cred = await did.assignDid('lewiston-id', null, {
      firstName: 'Jane',
      lastName: 'Doe',
      serviceAddress: {
        line1: '1 Main St', line2: '', city: 'Lewiston', state: 'ID', zip: '83501',
      },
    });

    expect(telnyx.createE911Address).toHaveBeenCalledWith({
      firstName: 'Jane',
      lastName: 'Doe',
      line1: '1 Main St',
      line2: '',
      city: 'Lewiston',
      state: 'ID',
      zip: '83501',
    });
    // The number (signalwireSid), not the SIP credential, gets E911 enabled.
    expect(telnyx.enableE911).toHaveBeenCalledWith({ phoneNumberId: 'sid-1', addressId: 'addr-9' });
    expect(cred).toMatchObject({ e911AddressId: 'addr-9', e911Enabled: true });
    // CNAM uses the subscriber's name (15-char PSTN cap).
    expect(telnyx.updatePhoneNumber).toHaveBeenCalledWith('+12085550100', {
      cnam_listing_enabled: true,
      caller_id_name_as: 'Jane Doe',
    });
  });

  it('does not fail account creation when CNAM registration throws', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValueOnce([{ number: '+12085550100' }]);
    telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-1' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({
      id: 'ep-1', sip_username: 'u', sip_password: 'p',
    });
    // 1st updatePhoneNumber = outbound voice profile (must succeed); 2nd = CNAM
    // (best-effort — its failure must not fail account creation).
    telnyx.updatePhoneNumber
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('telnyx 422'));

    const cred = await did.assignDid('lewiston-id');
    expect(cred).toMatchObject({ phoneE164: '+12085550100', sipEndpointId: 'ep-1' });
  });

  it('propagates a failure to attach the outbound voice profile (not best-effort)', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValueOnce([{ number: '+12085550100' }]);
    telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-1' });
    telnyx.updatePhoneNumber.mockRejectedValueOnce(new Error('telnyx 422'));

    await expect(did.assignDid('lewiston-id')).rejects.toThrow('telnyx 422');
    // Failed before creating the SIP credential.
    expect(telnyx.createSipEndpoint).not.toHaveBeenCalled();
  });

  it('truncates a long subscriber name to the 15-char CNAM limit', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValueOnce([{ number: '+12085550100' }]);
    telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-1' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({
      id: 'ep-1', sip_username: 'u', sip_password: 'p',
    });

    await did.assignDid('lewiston-id', null, { firstName: 'Bartholomew', lastName: 'Cumberbatch' });
    expect(telnyx.updatePhoneNumber).toHaveBeenCalledWith('+12085550100', {
      cnam_listing_enabled: true,
      caller_id_name_as: 'Bartholomew Cum', // 'Bartholomew Cumberbatch'.substring(0,15)
    });
  });

  it('does not call E911 when no serviceAddress is supplied', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValueOnce([{ number: '+12085550100' }]);
    telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-1' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({
      id: 'ep-1', sip_username: 'u', sip_password: 'p',
    });

    const cred = await did.assignDid('lewiston-id');

    expect(telnyx.createE911Address).not.toHaveBeenCalled();
    expect(telnyx.enableE911).not.toHaveBeenCalled();
    expect(cred).toMatchObject({ e911AddressId: null, e911Enabled: false });
  });

  it('does not fail account creation when E911 provisioning throws (best-effort)', async () => {
    telnyx.searchAvailableNumbers.mockResolvedValueOnce([{ number: '+12085550100' }]);
    telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-1' });
    telnyx.createSipEndpoint.mockResolvedValueOnce({
      id: 'ep-1', sip_username: 'u', sip_password: 'p',
    });
    telnyx.createE911Address.mockRejectedValueOnce(new Error('telnyx 422'));

    const cred = await did.assignDid('lewiston-id', null, {
      serviceAddress: {
        line1: '1 Main St', city: 'Lewiston', state: 'ID', zip: '83501',
      },
    });

    expect(cred).toMatchObject({ phoneE164: '+12085550100', e911AddressId: null, e911Enabled: false });
    expect(logger.error).toHaveBeenCalled();
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

  describe('with a customer-selected number (requestedNumber)', () => {
    it('purchases THAT exact number and never searches the area code', async () => {
      telnyx.provisionPhoneNumber.mockResolvedValueOnce({ id: 'sid-req' });
      telnyx.createSipEndpoint.mockResolvedValueOnce({
        id: 'ep-req', sip_username: 'u-req', sip_password: 'p-req',
      });

      const cred = await did.assignDid('lewiston-id', '208', {}, '+12085550142');

      // The exact number is purchased; no availability search / substitution.
      expect(telnyx.provisionPhoneNumber).toHaveBeenCalledWith('+12085550142');
      expect(telnyx.searchAvailableNumbers).not.toHaveBeenCalled();
      expect(cred.phoneE164).toBe('+12085550142');
      expect(cred.areaCode).toBe('208');
    });

    it('throws DID_UNAVAILABLE (no fallback) when Telnyx rejects the exact number 4xx', async () => {
      const err = new Error('Telnyx rejected POST /number_orders (404).');
      err.upstreamStatus = 404;
      telnyx.provisionPhoneNumber.mockRejectedValueOnce(err);

      await expect(did.assignDid('lewiston-id', '208', {}, '+12085550142'))
        .rejects.toMatchObject({
          code: 'DID_UNAVAILABLE',
          field: 'phone_e164',
          message: 'The number you selected is no longer available. Please go back and choose a different number.',
        });
      // Never fell back to auto-selecting a different number.
      expect(telnyx.searchAvailableNumbers).not.toHaveBeenCalled();
    });

    it('propagates a non-4xx Telnyx error unchanged (not masked as DID_UNAVAILABLE)', async () => {
      const err = new Error('Telnyx request failed after retries.');
      err.code = 'TELNYX_ERROR';
      err.upstreamStatus = 500;
      telnyx.provisionPhoneNumber.mockRejectedValueOnce(err);

      await expect(did.assignDid('lewiston-id', '208', {}, '+12085550142'))
        .rejects.toMatchObject({ code: 'TELNYX_ERROR' });
    });
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
