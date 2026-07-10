jest.mock('../../src/db');
jest.mock('../../src/integrations/telnyx');
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/notificationService');
jest.mock('../../src/utils/crypto', () => ({
  encrypt: jest.fn((s) => `enc:${s}`),
  decrypt: jest.fn((s) => String(s).replace(/^enc:/, '')),
}));
jest.mock('../../src/config', () => ({
  provisioning: { baseUrl: 'https://mw.example' },
  telnyx: { outboundVoiceProfileId: 'ovp-1' },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {},
  },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const telnyx = require('../../src/integrations/telnyx');
const accountService = require('../../src/services/accountService');
const notificationService = require('../../src/services/notificationService');
const crypto = require('../../src/utils/crypto');
const portService = require('../../src/services/portService');

const ACCOUNT = {
  id: 'acc-1',
  phone_e164: '+12085550100', // the temp DID assigned at signup
  first_name: 'Jane',
  last_name: 'Doe',
  market: 'lewiston-id',
  e911_address_id: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  accountService.getAccountById.mockResolvedValue(ACCOUNT);
});

describe('checkPortability', () => {
  it('requires a phone number', async () => {
    await expect(portService.checkPortability('')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('proxies the Telnyx portability result', async () => {
    telnyx.checkPortability.mockResolvedValueOnce({
      portable: true, fast_portable: true, carrier_name: 'AT&T', not_portable_reason: null,
    });
    const result = await portService.checkPortability('+12085550142');
    expect(result.portable).toBe(true);
    expect(telnyx.checkPortability).toHaveBeenCalledWith('+12085550142');
  });
});

describe('createPort', () => {
  const details = {
    phoneNumber: '+12085550142',
    accountNumber: 'ACC-99887',
    pin: '4321',
    authName: 'Jane Doe',
  };

  function portableOnce() {
    telnyx.checkPortability.mockResolvedValueOnce({
      portable: true, fast_portable: true, carrier_name: 'AT&T', not_portable_reason: null,
    });
  }

  it('validates required fields', async () => {
    await expect(portService.createPort('acc-1', { pin: '1', accountNumber: '2' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'phone_number' });
    await expect(portService.createPort('acc-1', { phoneNumber: '+1', pin: '1' }))
      .rejects.toMatchObject({ field: 'account_number' });
    await expect(portService.createPort('acc-1', { phoneNumber: '+1', accountNumber: '2' }))
      .rejects.toMatchObject({ field: 'pin' });
  });

  it('rejects when a port is already open', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'existing' }] }); // open-port check
    await expect(portService.createPort('acc-1', details))
      .rejects.toMatchObject({ code: 'PORT_ALREADY_PENDING' });
  });

  it('rejects a non-portable number without opening an order', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // open-port check
    telnyx.checkPortability.mockResolvedValueOnce({
      portable: false, not_portable_reason: 'Already ported', fast_portable: false, carrier_name: null,
    });
    await expect(portService.createPort('acc-1', details))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'phone_number' });
    expect(telnyx.createPortOrder).not.toHaveBeenCalled();
  });

  it('encrypts secrets, records the temp DID, and returns a secret-free row', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // open-port check
      .mockResolvedValueOnce({ // INSERT ... RETURNING *
        rows: [{
          id: 'po-1',
          account_id: 'acc-1',
          telnyx_port_order_id: 'tpo-1',
          phone_number: '+12085550142',
          status: 'draft',
          fast_port_eligible: true,
          carrier_name: 'AT&T',
          temp_did: '+12085550100',
          account_number_encrypted: 'enc:ACC-99887',
          pin_encrypted: 'enc:4321',
          auth_person_name: 'Jane Doe',
        }],
      });
    portableOnce();
    telnyx.createPortOrder.mockResolvedValueOnce({ id: 'tpo-1', status: 'draft' });
    telnyx.updatePortOrder.mockResolvedValueOnce({});

    const result = await portService.createPort('acc-1', details);

    // Secrets are encrypted at rest and never returned.
    expect(crypto.encrypt).toHaveBeenCalledWith('ACC-99887');
    expect(crypto.encrypt).toHaveBeenCalledWith('4321');
    expect(result).not.toHaveProperty('account_number_encrypted');
    expect(result).not.toHaveProperty('pin_encrypted');
    expect(result.status).toBe('draft');
    expect(result.temp_did).toBe('+12085550100');

    // Telnyx order opened + carrier details forwarded (PIN in that call only).
    expect(telnyx.createPortOrder).toHaveBeenCalledWith(['+12085550142'], 'https://mw.example/v1/webhooks/porting');
    const updateArg = telnyx.updatePortOrder.mock.calls[0][1];
    expect(updateArg.end_user.admin.pin_passcode).toBe('4321');

    // INSERT stored the ENCRYPTED values, not plaintext.
    const insertParams = db.query.mock.calls[1][1];
    expect(insertParams).toContain('enc:ACC-99887');
    expect(insertParams).toContain('enc:4321');
    expect(insertParams).not.toContain('4321');
  });

  it('maps a PORT_SUBMISSION_FAILED when Telnyx order creation throws', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // open-port check
    portableOnce();
    telnyx.createPortOrder.mockRejectedValueOnce(new Error('telnyx down'));
    await expect(portService.createPort('acc-1', details))
      .rejects.toMatchObject({ code: 'PORT_SUBMISSION_FAILED' });
  });

  it('still persists the order when forwarding carrier details fails', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'po-1', status: 'draft', phone_number: '+12085550142' }] });
    portableOnce();
    telnyx.createPortOrder.mockResolvedValueOnce({ id: 'tpo-1', status: 'draft' });
    telnyx.updatePortOrder.mockRejectedValueOnce(new Error('schema mismatch'));
    const result = await portService.createPort('acc-1', details);
    expect(result.id).toBe('po-1');
    // The INSERT still ran (2nd db.query call).
    expect(db.query.mock.calls[1][0]).toContain('INSERT INTO port_orders');
  });
});

describe('getPortStatus', () => {
  it('returns the latest port order, secrets stripped', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'po-1', status: 'submitted', pin_encrypted: 'enc:x', account_number_encrypted: 'enc:y',
      }],
    });
    const result = await portService.getPortStatus('acc-1');
    expect(result.status).toBe('submitted');
    expect(result).not.toHaveProperty('pin_encrypted');
  });

  it('returns null when the subscriber has no port', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await portService.getPortStatus('acc-1')).toBeNull();
  });
});

describe('cancelPort', () => {
  it('marks an open port cancelled', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'po-1', status: 'submitted', telnyx_port_order_id: 'tpo-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'po-1', status: 'cancelled' }] });
    telnyx.updatePortOrder.mockResolvedValueOnce({});
    const result = await portService.cancelPort('acc-1');
    expect(result.status).toBe('cancelled');
    expect(db.query.mock.calls[1][0]).toContain("status = 'cancelled'");
  });

  it('refuses to cancel a completed port', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'po-1', status: 'ported' }] });
    await expect(portService.cancelPort('acc-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('404s when there is no port to cancel', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(portService.cancelPort('acc-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('handlePortingWebhook', () => {
  function client() {
    return { query: jest.fn().mockResolvedValue({ rows: [] }) };
  }

  it('acks (unhandled) when the porting order id is missing', async () => {
    const res = await portService.handlePortingWebhook({ data: { payload: {} } });
    expect(res).toEqual({ handled: false, reason: 'missing_port_order_id' });
  });

  it('acks (unhandled) for an unknown porting order', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await portService.handlePortingWebhook({
      data: { payload: { id: 'tpo-x', status: 'submitted' } },
    });
    expect(res).toEqual({ handled: false, reason: 'unknown_port_order' });
  });

  it('is idempotent on a terminal order', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'po-1', status: 'ported', account_id: 'acc-1' }] });
    const res = await portService.handlePortingWebhook({
      data: { payload: { id: 'tpo-1', status: 'ported' } },
    });
    expect(res).toMatchObject({ handled: true, idempotent: true });
  });

  it('records a forward status move and notifies', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'po-1', status: 'submitted', account_id: 'acc-1', phone_number: '+12085550142',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE
    const res = await portService.handlePortingWebhook({
      data: { payload: { id: 'tpo-1', status: 'foc-date-confirmed', foc_date: '2026-07-15' } },
    });
    expect(res).toMatchObject({ handled: true, status: 'foc_confirmed' });
    expect(notificationService.notify).toHaveBeenCalledWith({ id: 'acc-1' }, 'port.foc_confirmed', expect.any(Object));
  });

  it('runs the number swap on "ported": assigns number, releases temp DID, points account', async () => {
    const swapClient = client();
    db.query
      .mockResolvedValueOnce({ // lookup
        rows: [{
          id: 'po-1',
          status: 'submitted',
          account_id: 'acc-1',
          phone_number: '+12085550142',
          temp_did: '+12085550100',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE status
    // completePortedNumber: dids SELECT returns none -> INSERT path
    swapClient.query
      .mockResolvedValueOnce({ rows: [] }) // SELECT dids
      .mockResolvedValueOnce({ rows: [] }) // INSERT dids
      .mockResolvedValueOnce({ rows: [] }) // release temp DID
      .mockResolvedValueOnce({ rows: [] }) // UPDATE accounts
      .mockResolvedValueOnce({ rows: [] }); // UPDATE port_orders ported
    db.withTransaction.mockImplementationOnce(async (fn) => fn(swapClient));
    telnyx.updatePhoneNumber.mockResolvedValueOnce({});

    const res = await portService.handlePortingWebhook({
      data: { payload: { id: 'tpo-1', status: 'ported' } },
    });
    expect(res).toMatchObject({ handled: true, status: 'ported' });
    // Routed the ported number (CNAM + outbound profile).
    expect(telnyx.updatePhoneNumber).toHaveBeenCalledWith('+12085550142', expect.objectContaining({
      outbound_voice_profile_id: 'ovp-1',
      cnam_listing_enabled: true,
    }));
    // Temp DID released back to the pool.
    const releasedCall = swapClient.query.mock.calls.find(
      (c) => c[0].includes("status = 'available'"),
    );
    expect(releasedCall[1]).toContain('+12085550100');
    // Account pointed at the ported number.
    const acctCall = swapClient.query.mock.calls.find((c) => c[0].includes('UPDATE accounts'));
    expect(acctCall[1]).toEqual(['acc-1', '+12085550142']);
  });
});
