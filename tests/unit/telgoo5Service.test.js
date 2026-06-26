jest.mock('../../src/db');
jest.mock('../../src/integrations/telgoo5');
jest.mock('../../src/config', () => ({ telgoo5: { carrier: 'CARRIER_X' } }));
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const telgoo5 = require('../../src/integrations/telgoo5');
const svc = require('../../src/services/telgoo5Service');

const account = { id: 'acc-1', email: 'jane@x.co', plan: 'unlimited_25' };
const input = {
  firstName: 'Jane',
  lastName: 'Doe',
  serviceAddress: { zip: '83501' },
  billingAddress: { zip: '83501' },
  paymentDetails: { planId: 'P1', planCode: 'UL', paymentMethod: 'CASH' },
};

beforeEach(() => {
  db.query.mockReset();
  telgoo5.checkServiceAvailability.mockReset();
  telgoo5.makePayment.mockReset();
  telgoo5.createCustomer.mockReset();
});

describe('enrollSubscriber', () => {
  it('runs availability -> payment -> customer and records the ids', async () => {
    telgoo5.checkServiceAvailability.mockResolvedValueOnce({ enrollmentId: 'E1', zipCode: '83501' });
    telgoo5.makePayment.mockResolvedValueOnce({ orderId: 'O1' });
    telgoo5.createCustomer.mockResolvedValueOnce([{ custId: 'C1', enrollmentId: 'E1' }]);
    db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE accounts

    const r = await svc.enrollSubscriber(account, input);

    expect(r).toEqual({ custId: 'C1', enrollmentId: 'E1', orderId: 'O1' });
    expect(telgoo5.checkServiceAvailability).toHaveBeenCalledWith('83501');
    expect(telgoo5.makePayment).toHaveBeenCalledWith(expect.objectContaining({
      enrollmentId: 'E1', planId: 'P1', email: 'jane@x.co', numberOfLines: 1,
    }));
    expect(telgoo5.createCustomer).toHaveBeenCalledWith(expect.objectContaining({
      parentEnrollmentId: 'E1',
    }));
    // Persists the linkage on the account.
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE accounts SET telgoo5_customer_id/);
    expect(params).toEqual(['C1', 'E1', 'acc-1']);
  });

  it('propagates a payment failure and does not create a customer', async () => {
    telgoo5.checkServiceAvailability.mockResolvedValueOnce({ enrollmentId: 'E1', zipCode: '83501' });
    telgoo5.makePayment.mockRejectedValueOnce(
      Object.assign(new Error('card declined'), { code: 'TELGOO5_ERROR' }),
    );

    await expect(svc.enrollSubscriber(account, input))
      .rejects.toMatchObject({ code: 'TELGOO5_ERROR' });
    expect(telgoo5.createCustomer).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('syncAccountToTelgoo5 (best-effort)', () => {
  it('reads the account and enrolls it', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [account] }) // SELECT account
      .mockResolvedValueOnce({ rows: [] }); // UPDATE (inside enrollSubscriber)
    telgoo5.checkServiceAvailability.mockResolvedValueOnce({ enrollmentId: 'E1', zipCode: '83501' });
    telgoo5.makePayment.mockResolvedValueOnce({ orderId: 'O1' });
    telgoo5.createCustomer.mockResolvedValueOnce([{ custId: 'C1', enrollmentId: 'E1' }]);

    const r = await svc.syncAccountToTelgoo5('acc-1', input);
    expect(r).toMatchObject({ synced: true, custId: 'C1', enrollmentId: 'E1' });
  });

  it('never throws on a Telgoo5 failure — returns { synced: false }', async () => {
    db.query.mockResolvedValueOnce({ rows: [account] }); // SELECT account
    telgoo5.checkServiceAvailability.mockRejectedValueOnce(
      Object.assign(new Error('telgoo down'), { code: 'TELGOO5_ERROR' }),
    );

    const r = await svc.syncAccountToTelgoo5('acc-1', input);
    expect(r).toEqual({ synced: false, error: 'telgoo down' });
  });

  it('skips when the account is not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await svc.syncAccountToTelgoo5('missing', input);
    expect(r).toEqual({ synced: false, reason: 'account not found' });
    expect(telgoo5.checkServiceAvailability).not.toHaveBeenCalled();
  });
});
