/**
 * Telgoo5 (vCare) BSS integration — the ONLY module that talks to Telgoo5
 * (CLAUDE.md: never call a vendor directly from routes/services elsewhere).
 * Telgoo5 handles standalone-mobile billing + enrollment.
 *
 * Token model (critical): tokens expire in ~15 seconds and are single-use —
 * every successful response returns a NEW token that must be used on the next
 * call. We keep the latest token in memory and chain it. When Telgoo5 reports
 * RESTAPI001 (token expired/used) we re-authenticate and retry the call once.
 *
 * Response shape isn't fully pinned by the spec, so token / code / message /
 * payload are pulled via tolerant extractors (camelCase + snake_case). Outgoing
 * request bodies follow the documented spec exactly.
 *
 * Uses the global fetch from Node 20. Throws AppError('TELGOO5_ERROR') on
 * failure. Credentials/token are never logged.
 */
const config = require('../config');
const { logger } = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

// Telgoo5 response codes.
const SUCCESS_CODE = 'RESTAPI000';
const TOKEN_ERROR_CODE = 'RESTAPI001';
// The token rides in this request header.
const TOKEN_HEADER = 'token';

// Latest chained token. Refreshed from every response; reset via authenticate().
let currentToken = null;

function baseUrl() {
  return config.telgoo5.baseUrl || 'https://www.vcareapi.com:8080';
}

// --- tolerant response extractors ---
function codeOf(body) {
  if (!body) return null;
  return body.responseCode || body.response_code || body.code || null;
}
function tokenOf(body) {
  if (!body) return null;
  return body.token || (body.data && body.data.token) || null;
}
function messageOf(body) {
  if (!body) return null;
  return body.responseMessage || body.response_message || body.message || null;
}
/** The endpoint payload (body.data when present, else the body itself). */
function dataOf(body) {
  if (!body) return {};
  return body.data !== undefined && body.data !== null ? body.data : body;
}
/** Pull a list out of a response: top-level array, data array, or data[key]. */
function listFrom(body, key) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && body.data && Array.isArray(body.data[key])) return body.data[key];
  if (body && Array.isArray(body[key])) return body[key];
  return [];
}
/** "Y"/true → true. */
function yn(v) {
  return v === 'Y' || v === 'y' || v === true;
}

/**
 * Authenticate against Telgoo5 and cache the returned token. Re-callable to
 * force a refresh; returns the token string.
 */
async function authenticate() {
  const res = await fetch(`${baseUrl()}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vendor_id: config.telgoo5.vendorId,
      username: config.telgoo5.username,
      password: config.telgoo5.password,
      pin: config.telgoo5.pin,
    }),
  });
  if (!res.ok) {
    throw new AppError('TELGOO5_ERROR', `Telgoo5 authentication failed (${res.status}).`, { status: 502 });
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  const token = tokenOf(body);
  if (!token) {
    throw new AppError('TELGOO5_ERROR', 'Telgoo5 authentication returned no token.', { status: 502 });
  }
  currentToken = token;
  logger.debug('Telgoo5 authenticated'); // never log the token/credentials
  return token;
}

/**
 * Issue a Telgoo5 request with token chaining. On success, stores the new token
 * from the response. On RESTAPI001 (token expired/used), re-authenticates and
 * retries once. Returns the parsed response body.
 */
async function request(method, path, body, retried = false) {
  if (!currentToken) await authenticate();

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [TOKEN_HEADER]: currentToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = res.status === 204 ? '' : await res.text();
  const parsed = text ? JSON.parse(text) : null;
  const code = codeOf(parsed);
  logger.debug({
    method, path, status: res.status, code,
  }, 'Telgoo5 response');

  if (!res.ok) {
    throw new AppError('TELGOO5_ERROR', `Telgoo5 ${method} ${path} failed (${res.status}).`, { status: 502 });
  }

  // Token expired/used — re-auth once and replay.
  if (code === TOKEN_ERROR_CODE && !retried) {
    await authenticate();
    return request(method, path, body, true);
  }

  // Chain the new token for the next call.
  const next = tokenOf(parsed);
  if (next) currentToken = next;

  // A present, non-success code is a business failure.
  if (code && code !== SUCCESS_CODE) {
    throw new AppError(
      'TELGOO5_ERROR',
      messageOf(parsed) || `Telgoo5 ${method} ${path} failed (${code}).`,
      { status: 502 },
    );
  }
  return parsed;
}

// --- Typed API surface ---

/**
 * Check service availability for a ZIP. Returns { enrollmentId, city, state, zipCode }.
 */
async function checkServiceAvailability(zipCode) {
  const res = await request('POST', '/enrollment', {
    action: 'check_service_availability',
    zip_code: zipCode,
    enrollment_type: 'NON_LIFELINE',
    is_enrollment: 'Y',
    agent_id: config.telgoo5.agentId,
    source: 'API',
  });
  const d = dataOf(res);
  return {
    enrollmentId: d.enrollment_id || d.enrollmentId || null,
    city: d.city || null,
    state: d.state || null,
    zipCode: d.zip_code || d.zipCode || zipCode,
  };
}

/** List plans for a ZIP. Returns an array of mapped plan objects. */
async function getPlans(zipCode, isFamilyPlan = false) {
  const res = await request('POST', '/plan', {
    action: 'plan_list',
    zip_code: zipCode,
    enrollment_type: 'NON_LIFELINE',
    is_family_plan: isFamilyPlan ? 'Y' : 'N',
    agent_id: config.telgoo5.agentId,
    source: 'API',
  });
  return listFrom(res, 'plans').map((p) => ({
    planId: p.plan_id || p.planId || null,
    planName: p.plan_name || p.planName || null,
    planPrice: p.plan_price || p.planPrice || null,
    planCode: p.plan_code || p.planCode || null,
    data: p.data || null,
    talk: p.talk || null,
    text: p.text || null,
    dataUnlimited: yn(p.data_unlimited),
    minuteUnlimited: yn(p.minute_unlimited),
    textUnlimited: yn(p.text_unlimited),
    carrier: p.carrier || null,
    familyPlanConfig: p.family_plan_config || p.familyPlanConfig || null,
    displayFeatures: p.display_features || p.displayFeatures || null,
    isPrepaid: yn(p.is_prepaid),
  }));
}

/** Build the payment-method-specific fields for makePayment. */
function paymentFields(paymentMethod, cardDetails = {}) {
  if (paymentMethod === 'CREDIT_CARD') {
    return {
      card_number: cardDetails.cardNumber,
      cvv: cardDetails.cvv,
      expiration_month: cardDetails.expirationMonth,
      expiration_year: cardDetails.expirationYear,
      name_on_card: cardDetails.nameOnCard,
      card_type: cardDetails.cardType,
    };
  }
  if (paymentMethod === 'OTHER_PAYMENT_OPTION') {
    // Stripe hosted checkout — reference the completed Stripe charge.
    return {
      payment_option: cardDetails.paymentOption || 'STRIPE',
      transaction_id: cardDetails.transactionId,
      charge_id: cardDetails.chargeId,
    };
  }
  // CASH (or anything else) — nothing extra to send.
  return {};
}

/**
 * Get a payment quote (amounts + tax breakdown) before charging. Returns
 * { planAmount, tax, totalAmount, taxBreakup: [{ name, amount }], activationFee,
 *   shippingAmount, processingFee, totalDiscount, state }.
 */
async function getPaymentDetails({
  zipCode, planId, paymentType, enrollmentId, numberOfLines,
}) {
  const res = await request('POST', '/payment', {
    action: 'payment_details',
    zip_code: zipCode,
    payment_type: paymentType || 'NEW_SIGNUP',
    payment_method: 'CREDIT_CARD',
    plan_id: [{ id: String(planId), no_of_months: '1' }],
    agent_id: config.telgoo5.agentId,
    source: 'API',
    enrollment_id: enrollmentId || '',
    number_of_lines: numberOfLines,
  });
  const d = dataOf(res);
  const plan = d.plan || {};
  return {
    planAmount: d.total_actual_amount || null,
    tax: d.total_tax || null,
    totalAmount: d.total_amount || null,
    taxBreakup: (plan.tax_breakup || []).map((t) => ({
      name: t.name || null,
      amount: t.amount || null,
    })),
    activationFee: d.total_activation_fee || null,
    shippingAmount: d.total_shipping_amount || null,
    processingFee: d.total_processing_fee || null,
    totalDiscount: d.total_discount || null,
    state: d.state || null,
  };
}

/**
 * Make a payment (NEW_SIGNUP sale). Supports CREDIT_CARD, OTHER_PAYMENT_OPTION
 * (Stripe), and CASH. Returns
 * { orderId, invoiceNumber, totalAmount, planTax, paymentStatus, transactionNo }.
 */
async function makePayment({
  enrollmentId, zipCode, planId, planCode, billingAddress, paymentMethod,
  cardDetails, email, numberOfLines, couponCode,
}) {
  const res = await request('POST', '/payment', {
    action: 'make_payment',
    type: 'sale',
    payment_type: 'NEW_SIGNUP',
    save_card: 'Y',
    source: 'API',
    agent_id: config.telgoo5.agentId,
    change_plan_type: '',
    enrollment_id: enrollmentId,
    zip_code: zipCode,
    plan_id: planId,
    plan_code: planCode,
    billing_address: billingAddress,
    payment_method: paymentMethod,
    email,
    number_of_lines: numberOfLines,
    coupon_code: couponCode,
    ...paymentFields(paymentMethod, cardDetails),
  });
  const d = dataOf(res);
  return {
    orderId: d.order_id || d.orderId || null,
    invoiceNumber: d.invoice_number || d.invoiceNumber || null,
    totalAmount: d.total_amount || d.totalAmount || null,
    planTax: d.plan_tax || d.planTax || null,
    paymentStatus: d.payment_status || d.paymentStatus || null,
    transactionNo: d.transaction_no || d.transactionNo || null,
  };
}

/**
 * Create one or more customer lines. Returns an array of
 * { custId, customerId, enrollmentId, enrollmentType, mdn, esim? }.
 */
async function createCustomer({
  parentEnrollmentId, lines, externalTransactionId, couponCode,
}) {
  const res = await request('POST', '/customer', {
    action: 'create_prepaid_postpaid_customer_v2',
    source: 'API',
    request_name: 'customer',
    agent_id: config.telgoo5.agentId,
    parent_enrollment_id: parentEnrollmentId,
    external_transaction_id: externalTransactionId,
    coupon_code: couponCode,
    lines: (lines || []).map((l) => ({
      enrollment_id: l.enrollmentId,
      order_id: l.orderId,
      plan_id: l.planId,
      is_esim: l.isEsim || 'Y',
      enrollment_type: l.enrollmentType || 'SHIPMENT',
      carrier: l.carrier,
      email: l.email,
      first_name: l.firstName,
      last_name: l.lastName,
      service_address: l.serviceAddress,
      billing_address: l.billingAddress,
      ...(l.portDetails ? { port_details: l.portDetails } : {}),
    })),
  });
  return listFrom(res, 'customers').map((c) => {
    const mapped = {
      custId: c.cust_id || c.custId || null,
      customerId: c.customer_id || c.customerId || null,
      enrollmentId: c.enrollment_id || c.enrollmentId || null,
      enrollmentType: c.enrollment_type || c.enrollmentType || null,
      mdn: c.mdn || null,
    };
    if (c.esim) mapped.esim = c.esim;
    return mapped;
  });
}

module.exports = {
  authenticate,
  checkServiceAvailability,
  getPlans,
  getPaymentDetails,
  makePayment,
  createCustomer,
  // exposed for tests
  request,
};
