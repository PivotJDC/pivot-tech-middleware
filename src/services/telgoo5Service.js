/**
 * Telgoo5 enrollment orchestration.
 *
 * enrollSubscriber runs the full Telgoo5 flow (availability → payment →
 * customer) and records the resulting ids on the account. syncAccountToTelgoo5
 * is the best-effort entry point called after our own account creation — it
 * never throws, so a Telgoo5 outage can't fail MobilityNet signup.
 *
 * Routes call into here; this module never touches HTTP.
 */
const db = require('../db');
const telgoo5 = require('../integrations/telgoo5');
const config = require('../config');
const { logger } = require('../utils/logger');

/**
 * Enroll a subscriber in Telgoo5 and persist the customer/enrollment ids.
 * @param {object} account - the account row (id, email, plan, phone_e164, ...).
 * @param {object} input
 * @param {string} input.firstName
 * @param {string} input.lastName
 * @param {{ zip: string, [k:string]: any }} input.serviceAddress
 * @param {object} input.billingAddress
 * @param {object} input.paymentDetails - { planId, planCode, paymentMethod,
 *   cardDetails, couponCode, portDetails? }
 * @returns {Promise<{ custId, enrollmentId, orderId }>}
 */
async function enrollSubscriber(account, input = {}) {
  const {
    firstName, lastName, serviceAddress = {}, billingAddress = {}, paymentDetails = {},
  } = input;

  // 1. Service availability → enrollment id.
  const availability = await telgoo5.checkServiceAvailability(serviceAddress.zip);
  const { enrollmentId } = availability;
  if (!enrollmentId) {
    logger.warn({ accountId: account.id }, 'Telgoo5 returned no enrollment id');
  }

  // 2. Payment quote (amounts + tax breakdown) before charging.
  const quote = await telgoo5.getPaymentDetails({
    zipCode: serviceAddress.zip,
    planId: paymentDetails.planId,
    paymentType: 'NEW_SIGNUP',
    enrollmentId,
    numberOfLines: 1,
  });
  logger.info(
    {
      accountId: account.id,
      planAmount: quote.planAmount,
      tax: quote.tax,
      totalAmount: quote.totalAmount,
      taxBreakup: quote.taxBreakup,
    },
    'Telgoo5 payment quote',
  );

  // 3. Payment → order id.
  const payment = await telgoo5.makePayment({
    enrollmentId,
    zipCode: serviceAddress.zip,
    planId: paymentDetails.planId,
    planCode: paymentDetails.planCode,
    billingAddress,
    paymentMethod: paymentDetails.paymentMethod,
    cardDetails: paymentDetails.cardDetails,
    email: account.email,
    numberOfLines: 1,
    couponCode: paymentDetails.couponCode,
  });
  const { orderId } = payment;

  // 4. Create the customer line.
  const customers = await telgoo5.createCustomer({
    parentEnrollmentId: enrollmentId,
    externalTransactionId: account.id,
    couponCode: paymentDetails.couponCode,
    lines: [{
      enrollmentId,
      orderId,
      planId: paymentDetails.planId,
      isEsim: 'Y',
      enrollmentType: 'SHIPMENT',
      carrier: config.telgoo5.carrier,
      email: account.email,
      firstName,
      lastName,
      serviceAddress,
      billingAddress,
      portDetails: paymentDetails.portDetails,
    }],
  });
  const custId = customers[0] && customers[0].custId;

  // 5. Record the linkage on the account.
  await db.query(
    'UPDATE accounts SET telgoo5_customer_id = $1, telgoo5_enrollment_id = $2 WHERE id = $3',
    [custId || null, enrollmentId || null, account.id],
  );

  logger.info(
    {
      accountId: account.id, custId, enrollmentId, orderId,
    },
    'Telgoo5 subscriber enrolled',
  );
  return { custId, enrollmentId, orderId };
}

/**
 * Sync an account to Telgoo5 after creation. Best-effort: reads the account and
 * enrolls it, logging (never throwing) on failure so MobilityNet account
 * creation is never blocked by a Telgoo5 issue.
 * @param {string} accountId
 * @param {object} [enrollmentInput] - enrollment data (name/address/payment);
 *   sourced from the signup flow once it captures them.
 * @returns {Promise<{ synced: boolean, custId?, enrollmentId?, orderId?, reason?, error? }>}
 */
async function syncAccountToTelgoo5(accountId, enrollmentInput = {}) {
  try {
    const { rows } = await db.query('SELECT * FROM accounts WHERE id = $1', [accountId]);
    if (rows.length === 0) {
      logger.warn({ accountId }, 'Telgoo5 sync skipped: account not found');
      return { synced: false, reason: 'account not found' };
    }
    const result = await enrollSubscriber(rows[0], enrollmentInput);
    return { synced: true, ...result };
  } catch (err) {
    logger.error({ accountId, err: err.message }, 'Telgoo5 sync failed (best-effort)');
    return { synced: false, error: err.message };
  }
}

module.exports = { enrollSubscriber, syncAccountToTelgoo5 };
