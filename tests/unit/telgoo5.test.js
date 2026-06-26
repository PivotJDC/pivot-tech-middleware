// Mock config: Telgoo5 credentials shape.
jest.mock('../../src/config', () => ({
  telgoo5: {
    baseUrl: 'https://telgoo.test',
    vendorId: 'v1',
    username: 'u',
    password: 'p',
    pin: '1234',
    agentId: 'agent-1',
    carrier: 'CARRIER_X',
  },
  logLevel: 'silent',
  isProduction: true,
}));

// Re-require per test so the module-level token resets.
let telgoo5;

function authResp(token) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ token, responseCode: 'RESTAPI000' }),
  };
}
function resp({
  token = 'tok-next', code = 'RESTAPI000', data = null, message,
} = {}) {
  const body = { token, responseCode: code, data };
  if (message) body.responseMessage = message;
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  // eslint-disable-next-line global-require
  telgoo5 = require('../../src/integrations/telgoo5');
});
afterAll(() => {
  delete global.fetch;
});

describe('authenticate', () => {
  it('posts credentials and stores the returned token', async () => {
    global.fetch.mockResolvedValueOnce(authResp('tok-1'));
    const t = await telgoo5.authenticate();
    expect(t).toBe('tok-1');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://telgoo.test/authenticate');
    expect(JSON.parse(init.body)).toEqual({
      vendor_id: 'v1', username: 'u', password: 'p', pin: '1234',
    });
  });

  it('throws TELGOO5_ERROR when no token is returned', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true, status: 200, text: async () => JSON.stringify({ responseCode: 'RESTAPI000' }),
    });
    await expect(telgoo5.authenticate()).rejects.toMatchObject({ code: 'TELGOO5_ERROR', status: 502 });
  });
});

describe('request token chaining', () => {
  it('auto-authenticates, then chains the new token from each response', async () => {
    global.fetch
      .mockResolvedValueOnce(authResp('tok-1')) // lazy authenticate
      .mockResolvedValueOnce(resp({ token: 'tok-2', data: { enrollment_id: 'E1' } })) // /enrollment
      .mockResolvedValueOnce(resp({ token: 'tok-3', data: [] })); // /plan

    await telgoo5.checkServiceAvailability('83501');
    await telgoo5.getPlans('83501');

    expect(global.fetch.mock.calls[0][0]).toBe('https://telgoo.test/authenticate');
    // /enrollment uses the auth token; /plan uses the token chained from /enrollment.
    expect(global.fetch.mock.calls[1][1].headers.token).toBe('tok-1');
    expect(global.fetch.mock.calls[2][1].headers.token).toBe('tok-2');
  });

  it('re-authenticates and retries once on RESTAPI001 (expired/used token)', async () => {
    global.fetch
      .mockResolvedValueOnce(authResp('tok-1')) // initial auth
      .mockResolvedValueOnce(resp({ code: 'RESTAPI001', token: null })) // token expired
      .mockResolvedValueOnce(authResp('tok-2')) // re-auth
      .mockResolvedValueOnce(resp({ token: 'tok-3', data: { enrollment_id: 'E1' } })); // retry ok

    const r = await telgoo5.checkServiceAvailability('83501');
    expect(r.enrollmentId).toBe('E1');
    expect(global.fetch).toHaveBeenCalledTimes(4);
    // The replayed call uses the freshly re-authenticated token.
    expect(global.fetch.mock.calls[3][1].headers.token).toBe('tok-2');
  });

  it('throws TELGOO5_ERROR on a non-success response code', async () => {
    global.fetch
      .mockResolvedValueOnce(authResp('tok-1'))
      .mockResolvedValueOnce(resp({ code: 'RESTAPI500', message: 'bad request', token: 'tok-2' }));
    await expect(telgoo5.checkServiceAvailability('83501'))
      .rejects.toMatchObject({ code: 'TELGOO5_ERROR' });
  });
});

describe('checkServiceAvailability', () => {
  it('sends the enrollment body and maps the result', async () => {
    global.fetch
      .mockResolvedValueOnce(authResp('tok-1'))
      .mockResolvedValueOnce(resp({
        token: 'tok-2',
        data: {
          enrollment_id: 'E1', city: 'Lewiston', state: 'ID', zip_code: '83501',
        },
      }));
    const r = await telgoo5.checkServiceAvailability('83501');
    expect(r).toEqual({
      enrollmentId: 'E1', city: 'Lewiston', state: 'ID', zipCode: '83501',
    });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({
      action: 'check_service_availability',
      zip_code: '83501',
      enrollment_type: 'NON_LIFELINE',
      is_enrollment: 'Y',
      agent_id: 'agent-1',
      source: 'API',
    });
  });
});

describe('getPlans', () => {
  it('maps plan fields and sends is_family_plan', async () => {
    global.fetch
      .mockResolvedValueOnce(authResp('tok-1'))
      .mockResolvedValueOnce(resp({
        token: 'tok-2',
        data: [{
          plan_id: 'P1',
          plan_name: 'Unlimited 30',
          plan_price: '25.00',
          plan_code: 'UL',
          data: '30GB',
          talk: 'Unlimited',
          text: 'Unlimited',
          data_unlimited: 'N',
          minute_unlimited: 'Y',
          text_unlimited: 'Y',
          carrier: 'CARRIER_X',
          family_plan_config: { maxLines: 5 },
          display_features: ['eSIM'],
          is_prepaid: 'Y',
        }],
      }));

    const plans = await telgoo5.getPlans('83501', true);
    expect(plans[0]).toEqual({
      planId: 'P1',
      planName: 'Unlimited 30',
      planPrice: '25.00',
      planCode: 'UL',
      data: '30GB',
      talk: 'Unlimited',
      text: 'Unlimited',
      dataUnlimited: false,
      minuteUnlimited: true,
      textUnlimited: true,
      carrier: 'CARRIER_X',
      familyPlanConfig: { maxLines: 5 },
      displayFeatures: ['eSIM'],
      isPrepaid: true,
    });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).is_family_plan).toBe('Y');
  });
});

describe('getPaymentDetails', () => {
  it('sends the payment_details body and maps the quote + tax breakup', async () => {
    global.fetch
      .mockResolvedValueOnce(authResp('tok-1'))
      .mockResolvedValueOnce(resp({
        token: 'tok-2',
        data: {
          total_actual_amount: '25.00',
          total_tax: '2.50',
          total_amount: '27.50',
          total_activation_fee: '5.00',
          total_shipping_amount: '0.00',
          total_processing_fee: '0.30',
          total_discount: '0.00',
          state: 'ID',
          plan: {
            tax_breakup: [
              { name: 'State Tax', amount: '1.50' },
              { name: 'E911', amount: '1.00' },
            ],
          },
        },
      }));

    const q = await telgoo5.getPaymentDetails({
      zipCode: '83501', planId: 'P1', enrollmentId: 'E1', numberOfLines: 1,
    });

    expect(q).toEqual({
      planAmount: '25.00',
      tax: '2.50',
      totalAmount: '27.50',
      taxBreakup: [
        { name: 'State Tax', amount: '1.50' },
        { name: 'E911', amount: '1.00' },
      ],
      activationFee: '5.00',
      shippingAmount: '0.00',
      processingFee: '0.30',
      totalDiscount: '0.00',
      state: 'ID',
    });

    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.action).toBe('payment_details');
    expect(body.payment_type).toBe('NEW_SIGNUP');
    expect(body.payment_method).toBe('CREDIT_CARD');
    expect(body.plan_id).toEqual([{ id: 'P1', no_of_months: '1' }]);
    expect(body.enrollment_id).toBe('E1');
    // chained the auth token onto this call.
    expect(global.fetch.mock.calls[1][1].headers.token).toBe('tok-1');
  });

  it('defaults tax breakup to [] and enrollment_id to "" when absent', async () => {
    global.fetch
      .mockResolvedValueOnce(authResp('tok-1'))
      .mockResolvedValueOnce(resp({ token: 'tok-2', data: { total_amount: '27.50' } }));
    const q = await telgoo5.getPaymentDetails({ zipCode: '83501', planId: 99 });
    expect(q.taxBreakup).toEqual([]);
    expect(q.totalAmount).toBe('27.50');
    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.plan_id).toEqual([{ id: '99', no_of_months: '1' }]);
    expect(body.enrollment_id).toBe('');
  });
});

describe('makePayment', () => {
  it('sends credit-card fields and maps the result', async () => {
    global.fetch
      .mockResolvedValueOnce(authResp('tok-1'))
      .mockResolvedValueOnce(resp({
        token: 'tok-2',
        data: {
          order_id: 'O1',
          invoice_number: 'INV1',
          total_amount: '27.00',
          plan_tax: '2.00',
          payment_status: 'PAID',
          transaction_no: 'TX1',
        },
      }));

    const r = await telgoo5.makePayment({
      enrollmentId: 'E1',
      zipCode: '83501',
      planId: 'P1',
      planCode: 'UL',
      billingAddress: { zip: '83501' },
      paymentMethod: 'CREDIT_CARD',
      cardDetails: {
        cardNumber: '4111', cvv: '123', expirationMonth: '12', expirationYear: '2030', nameOnCard: 'Jane', cardType: 'VISA',
      },
      email: 'jane@x.co',
      numberOfLines: 1,
      couponCode: '',
    });

    expect(r).toEqual({
      orderId: 'O1',
      invoiceNumber: 'INV1',
      totalAmount: '27.00',
      planTax: '2.00',
      paymentStatus: 'PAID',
      transactionNo: 'TX1',
    });
    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.action).toBe('make_payment');
    expect(body.payment_type).toBe('NEW_SIGNUP');
    expect(body.card_number).toBe('4111');
    expect(body.card_type).toBe('VISA');
  });

  it('sends Stripe fields for OTHER_PAYMENT_OPTION (no card number)', async () => {
    global.fetch
      .mockResolvedValueOnce(authResp('tok-1'))
      .mockResolvedValueOnce(resp({ token: 'tok-2', data: { order_id: 'O2' } }));

    await telgoo5.makePayment({
      enrollmentId: 'E1',
      zipCode: '83501',
      planId: 'P1',
      planCode: 'UL',
      billingAddress: {},
      paymentMethod: 'OTHER_PAYMENT_OPTION',
      cardDetails: { paymentOption: 'STRIPE', transactionId: 'tr_1', chargeId: 'ch_1' },
      email: 'jane@x.co',
      numberOfLines: 1,
    });

    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.payment_option).toBe('STRIPE');
    expect(body.transaction_id).toBe('tr_1');
    expect(body.charge_id).toBe('ch_1');
    expect(body.card_number).toBeUndefined();
  });
});

describe('createCustomer', () => {
  it('sends mapped lines and maps the customer result (incl. esim)', async () => {
    global.fetch
      .mockResolvedValueOnce(authResp('tok-1'))
      .mockResolvedValueOnce(resp({
        token: 'tok-2',
        data: [{
          cust_id: 'C1',
          customer_id: 'CU1',
          enrollment_id: 'E1',
          enrollment_type: 'SHIPMENT',
          mdn: '2085550100',
          esim: { lpa: 'LPA:1$...' },
        }],
      }));

    const custs = await telgoo5.createCustomer({
      parentEnrollmentId: 'E1',
      externalTransactionId: 'acc-1',
      lines: [{
        enrollmentId: 'E1',
        orderId: 'O1',
        planId: 'P1',
        carrier: 'CARRIER_X',
        email: 'jane@x.co',
        firstName: 'Jane',
        lastName: 'Doe',
        serviceAddress: { zip: '83501' },
        billingAddress: {},
      }],
    });

    expect(custs[0]).toEqual({
      custId: 'C1',
      customerId: 'CU1',
      enrollmentId: 'E1',
      enrollmentType: 'SHIPMENT',
      mdn: '2085550100',
      esim: { lpa: 'LPA:1$...' },
    });
    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.action).toBe('create_prepaid_postpaid_customer_v2');
    expect(body.lines[0].is_esim).toBe('Y');
    expect(body.lines[0].enrollment_type).toBe('SHIPMENT');
    expect(body.lines[0].first_name).toBe('Jane');
  });
});
