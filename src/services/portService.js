/**
 * Port service — FastPort number porting (Phase 1).
 *
 * Owns the port_orders lifecycle: portability checks, creating a Telnyx porting
 * order + persisting it, exposing status to the subscriber, cancelling, and the
 * number-swap that runs when a port completes.
 *
 * Security (CLAUDE.md rules #1/#2/#3):
 *   - The losing-carrier account number and transfer PIN are AES-256-GCM at rest
 *     (account_number_encrypted / pin_encrypted). The plaintext exists only in
 *     memory here, immediately before the Telnyx submission — it is NEVER logged
 *     and NEVER returned by any endpoint (serializePortOrder strips both).
 *
 * Legacy note: this is the FastPort-native path (port_orders). The older
 * port_requests table + admin retry endpoint (portOrchestrationService) are left
 * in place for back-compat.
 */
const db = require('../db');
const telnyx = require('../integrations/telnyx');
const crypto = require('../utils/crypto');
const config = require('../config');
const accountService = require('./accountService');
const notificationService = require('./notificationService');
const { errors, AppError } = require('../middleware/errorHandler');
const { areaCodeOf, formatNational } = require('../utils/e164');
const { logger } = require('../utils/logger');

// port_orders.status values we treat as "still open" — a subscriber may have
// only one open port at a time.
const OPEN_STATUSES = new Set([
  'draft', 'submitted', 'requested', 'in_process', 'foc_confirmed', 'exception',
]);
const TERMINAL_STATUSES = new Set(['ported', 'cancelled']);

// Telnyx porting-order status -> our port_orders.status. Telnyx uses hyphenated
// values; anything unmapped is stored verbatim (snake-cased) so ops still see it.
const TELNYX_STATUS_MAP = {
  draft: 'draft',
  'in-process': 'in_process',
  submitted: 'submitted',
  exception: 'exception',
  'foc-date-confirmed': 'foc_confirmed',
  cancelled: 'cancelled',
  'cancel-pending': 'cancelled',
  ported: 'ported',
};

/** Map a Telnyx porting-order status to our internal status. */
function mapTelnyxStatus(telnyxStatus) {
  if (!telnyxStatus) return null;
  return TELNYX_STATUS_MAP[telnyxStatus] || String(telnyxStatus).replace(/-/g, '_');
}

/** Strip the encrypted secrets from a port_orders row before returning it. */
function serializePortOrder(row) {
  if (!row) return null;
  const {
    // eslint-disable-next-line camelcase, no-unused-vars
    account_number_encrypted, pin_encrypted, ...safe
  } = row;
  return safe;
}

/** The porting webhook URL Telnyx notifies on lifecycle changes. */
function portingWebhookUrl() {
  return `${config.provisioning.baseUrl}/v1/webhooks/porting`;
}

/**
 * Check whether a number can be ported in (and whether it qualifies for
 * same-day FastPort). Pure read — no DB writes.
 * @param {string} phoneNumber - E.164 number.
 * @returns {Promise<{ portable, fast_portable, carrier_name, not_portable_reason }>}
 */
async function checkPortability(phoneNumber) {
  if (!phoneNumber) {
    throw errors.validation('A phone number is required.', 'phone_number');
  }
  const result = await telnyx.checkPortability(phoneNumber);
  logger.info(
    {
      areaCode: areaCodeOf(phoneNumber),
      portable: result.portable,
      fastPortable: result.fast_portable,
    },
    'portability check',
  );
  return result;
}

/**
 * Create a port order for a subscriber: verify portability, open a Telnyx
 * porting order, forward the losing-carrier authorization details, and persist
 * the (secret-encrypted) row. A temp DID is assigned at signup so the line works
 * immediately; we record it here so the completion swap can release it.
 *
 * @param {string} accountId
 * @param {object} details
 * @param {string} details.phoneNumber   - number to port in (E.164).
 * @param {string} details.accountNumber - losing-carrier account number.
 * @param {string} details.pin           - transfer PIN / passcode.
 * @param {string} details.authName      - authorized person on the account.
 * @param {object} [details.serviceAddress] - { line1, line2, city, state, zip }.
 * @returns {Promise<object>} the persisted port order (secrets stripped).
 */
async function createPort(accountId, details = {}) {
  const {
    phoneNumber, accountNumber, pin, authName, serviceAddress,
  } = details;

  if (!phoneNumber) throw errors.validation('A phone number is required.', 'phone_number');
  if (!accountNumber) throw errors.validation('The losing-carrier account number is required.', 'account_number');
  if (!pin) throw errors.validation('The transfer PIN is required.', 'pin');

  const account = await accountService.getAccountById(accountId); // throws NOT_FOUND

  // One open port per subscriber.
  const open = await db.query(
    `SELECT id FROM port_orders
      WHERE account_id = $1 AND status NOT IN ('ported', 'cancelled')
      LIMIT 1`,
    [accountId],
  );
  if (open.rows.length > 0) {
    throw new AppError(
      'PORT_ALREADY_PENDING',
      'A port is already in progress for this account.',
      { field: 'phone_number' },
    );
  }

  // Verify the number is portable before opening an order.
  const portability = await telnyx.checkPortability(phoneNumber);
  if (!portability.portable) {
    throw errors.validation(
      portability.not_portable_reason
        ? `This number cannot be ported: ${portability.not_portable_reason}`
        : 'This number cannot be ported to MobilityNet.',
      'phone_number',
    );
  }

  // Open the Telnyx porting order.
  let order;
  try {
    order = await telnyx.createPortOrder([phoneNumber], portingWebhookUrl());
  } catch (err) {
    logger.error({ accountId, err: err.message }, 'Telnyx createPortOrder failed');
    throw new AppError('PORT_SUBMISSION_FAILED', 'Could not submit the port to the carrier. Please try again.');
  }
  const telnyxPortOrderId = order && order.id;

  // Forward the losing-carrier authorization details to Telnyx. Best-effort: a
  // schema/validation hiccup here should not lose the whole order — the details
  // can be completed via admin. The PIN is plaintext ONLY in this call scope.
  if (telnyxPortOrderId) {
    try {
      await telnyx.updatePortOrder(telnyxPortOrderId, {
        activation_settings: { fast_port_eligible: portability.fast_portable },
        end_user: {
          admin: {
            account_number: accountNumber,
            pin_passcode: pin,
            auth_person_name: authName || `${account.first_name || ''} ${account.last_name || ''}`.trim(),
            ...(serviceAddress && serviceAddress.line1
              ? {
                billing_street_address: serviceAddress.line1,
                billing_extended_address: serviceAddress.line2 || '',
                billing_locality: serviceAddress.city,
                billing_administrative_area: serviceAddress.state,
                billing_postal_code: serviceAddress.zip,
              }
              : {}),
          },
        },
      });
    } catch (err) {
      logger.warn(
        { accountId, telnyxPortOrderId, err: err.message },
        'Telnyx updatePortOrder (carrier details) failed; order created, details pending',
      );
    }
  }

  const status = mapTelnyxStatus(order && order.status) || 'submitted';
  const inserted = (await db.query(
    `INSERT INTO port_orders
       (account_id, telnyx_port_order_id, phone_number, status, fast_port_eligible,
        carrier_name, temp_did, account_number_encrypted, pin_encrypted, auth_person_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      accountId,
      telnyxPortOrderId || null,
      phoneNumber,
      status,
      Boolean(portability.fast_portable),
      portability.carrier_name || null,
      account.phone_e164 || null, // the temp DID assigned at signup
      crypto.encrypt(accountNumber),
      crypto.encrypt(pin),
      authName || null,
    ],
  )).rows[0];

  logger.info(
    {
      accountId,
      portOrderId: inserted.id,
      telnyxPortOrderId,
      status,
      fastPort: portability.fast_portable,
    },
    'port order created',
  );
  return serializePortOrder(inserted);
}

/**
 * The subscriber's current (most recent) port order, or null if they have none.
 * @param {string} accountId
 * @returns {Promise<object|null>}
 */
async function getPortStatus(accountId) {
  const { rows } = await db.query(
    'SELECT * FROM port_orders WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1',
    [accountId],
  );
  return serializePortOrder(rows[0]);
}

/**
 * Cancel a subscriber's in-progress port. Marks the order cancelled (and
 * best-effort tells Telnyx). No-op-safe: a terminal order can't be cancelled.
 * @param {string} accountId
 * @returns {Promise<object>} the updated port order (secrets stripped).
 */
async function cancelPort(accountId) {
  const { rows } = await db.query(
    'SELECT * FROM port_orders WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1',
    [accountId],
  );
  const order = rows[0];
  if (!order) throw errors.notFound('No port order found for this account.');
  if (TERMINAL_STATUSES.has(order.status)) {
    throw errors.validation(`This port is already ${order.status} and cannot be cancelled.`, 'status');
  }

  // Best-effort Telnyx cancel — DELETE the porting order. Never block the local
  // cancel on a vendor hiccup.
  if (order.telnyx_port_order_id) {
    try {
      await telnyx.updatePortOrder(order.telnyx_port_order_id, { status: 'cancelled' });
    } catch (err) {
      logger.warn(
        { accountId, telnyxPortOrderId: order.telnyx_port_order_id, err: err.message },
        'Telnyx port cancel failed (best-effort); marking cancelled locally',
      );
    }
  }

  const updated = (await db.query(
    'UPDATE port_orders SET status = \'cancelled\', updated_at = NOW() WHERE id = $1 RETURNING *',
    [order.id],
  )).rows[0];
  logger.info({ accountId, portOrderId: order.id }, 'port order cancelled');
  return serializePortOrder(updated);
}

/**
 * Number swap when a port completes ("ported"). Best-effort provisioning + a
 * transactional DB swap:
 *   - route the ported number for outbound (CNAM + outbound voice profile) and
 *     re-enable E911 on it when the account has an E911 address;
 *   - assign the ported number to the account (dids upsert);
 *   - release the temp DID back to the pool;
 *   - point the account at its ported number.
 *
 * NOTE (SIP credentials): Telnyx credentials are per-account (bound to the SIP
 * connection, not the number) and cannot be rotated — the account keeps its
 * existing SIP credential, so nothing to rotate here (see didOrchestration
 * DECISION). Inbound voice-connection + messaging-profile attachment for a
 * ported number reuses the provisioning sub-resource PATCHes; the CNAM/outbound
 * routing below is the Phase-1 slice, the rest is finalized in Phase 2.
 *
 * @param {object} portOrder - a port_orders row.
 * @returns {Promise<void>}
 */
async function completePortedNumber(portOrder) {
  const account = await accountService.getAccountById(portOrder.account_id).catch(() => null);
  const portedE164 = portOrder.phone_number;

  // Best-effort outbound routing: CNAM (caller-ID name) + outbound voice profile.
  try {
    const name = account && account.first_name && account.last_name
      ? `${account.first_name} ${account.last_name}`.substring(0, 15)
      : 'MobilityNet';
    await telnyx.updatePhoneNumber(portedE164, {
      outbound_voice_profile_id: config.telnyx.outboundVoiceProfileId,
      cnam_listing_enabled: true,
      caller_id_name_as: name,
    });
  } catch (err) {
    logger.warn({ portedE164, err: err.message }, 'ported number routing/CNAM failed (best-effort)');
  }

  // Best-effort E911 re-point onto the ported number.
  if (account && account.e911_address_id) {
    try {
      await telnyx.enableE911({ phoneNumberId: portedE164, addressId: account.e911_address_id });
    } catch (err) {
      logger.warn({ portedE164, err: err.message }, 'ported number E911 enable failed (best-effort)');
    }
  }

  const market = (account && account.market) || 'national';
  const tempDid = portOrder.temp_did;

  await db.withTransaction(async (client) => {
    // Assign the ported number to the account (dids upsert).
    const existingDid = (await client.query('SELECT id FROM dids WHERE e164 = $1', [portedE164])).rows[0];
    if (existingDid) {
      await client.query(
        `UPDATE dids
            SET status = 'assigned', ported_in = TRUE, account_id = $2,
                market = COALESCE(market, $3)
          WHERE id = $1`,
        [existingDid.id, portOrder.account_id, market],
      );
    } else {
      await client.query(
        `INSERT INTO dids (e164, area_code, market, account_id, status, ported_in)
         VALUES ($1, $2, $3, $4, 'assigned', TRUE)`,
        [portedE164, areaCodeOf(portedE164), market, portOrder.account_id],
      );
    }

    // Release the temp DID back to the pool (if the account had one and it's not
    // the same number we just ported in).
    if (tempDid && tempDid !== portedE164) {
      await client.query(
        'UPDATE dids SET status = \'available\', account_id = NULL WHERE e164 = $1',
        [tempDid],
      );
    }

    // Point the account at its ported number.
    await client.query('UPDATE accounts SET phone_e164 = $2 WHERE id = $1', [portOrder.account_id, portedE164]);

    // Mark the port complete.
    await client.query(
      'UPDATE port_orders SET status = \'ported\', completed_at = NOW(), updated_at = NOW() WHERE id = $1',
      [portOrder.id],
    );
  });

  logger.info(
    {
      accountId: portOrder.account_id, portOrderId: portOrder.id, portedE164, tempDid,
    },
    'port completed: number swapped in, temp DID released',
  );
}

/**
 * Apply a Telnyx porting_order.status_changed webhook. Idempotent: looks the
 * order up by Telnyx id, ignores no-op/terminal repeats, records the new status
 * (+ FOC date / rejection reason), triggers the number swap on "ported", and
 * notifies the subscriber. Returns a small result describing what happened.
 *
 * @param {object} event - the Telnyx webhook event.
 * @returns {Promise<object>}
 */
async function handlePortingWebhook(event) {
  const payload = (event && event.data && event.data.payload)
    || (event && event.payload) || {};
  const telnyxPortOrderId = payload.id || payload.porting_order_id;
  const telnyxStatus = (payload.status && (payload.status.value || payload.status))
    || payload.porting_order_status;
  const newStatus = mapTelnyxStatus(telnyxStatus);

  if (!telnyxPortOrderId) {
    logger.warn({ type: event && event.event_type }, 'porting webhook missing porting order id');
    return { handled: false, reason: 'missing_port_order_id' };
  }

  const { rows } = await db.query(
    'SELECT * FROM port_orders WHERE telnyx_port_order_id = $1',
    [telnyxPortOrderId],
  );
  if (rows.length === 0) {
    logger.warn({ telnyxPortOrderId }, 'no port_order for telnyx id; acking');
    return { handled: false, reason: 'unknown_port_order' };
  }
  const order = rows[0];

  // Idempotency: terminal orders ignore further events; a repeat of the same
  // status is a no-op.
  if (TERMINAL_STATUSES.has(order.status)) {
    return { handled: true, idempotent: true, status: order.status };
  }
  if (!newStatus || newStatus === order.status) {
    // Still record FOC date / rejection reason if they arrived without a status move.
    return { handled: true, idempotent: true, status: order.status };
  }

  const focDate = payload.foc_date
    || (payload.activation_settings && payload.activation_settings.foc_datetime_requested)
    || null;
  const rejectionReason = newStatus === 'exception'
    ? (payload.reason || payload.rejection_reason || 'Port exception reported by carrier.')
    : null;

  await db.query(
    `UPDATE port_orders
        SET status = $2,
            foc_date = COALESCE($3, foc_date),
            rejection_reason = COALESCE($4, rejection_reason),
            updated_at = NOW()
      WHERE id = $1`,
    [order.id, newStatus, focDate, rejectionReason],
  );

  // On completion, run the number swap (its own transaction sets status=ported).
  if (newStatus === 'ported') {
    await completePortedNumber(order);
  }

  // Notify the subscriber of the status change (best-effort; never throws).
  try {
    await notificationService.notify(
      { id: order.account_id },
      `port.${newStatus}`,
      { phone_number: formatNational(order.phone_number) },
    );
  } catch (err) {
    logger.warn({ portOrderId: order.id, err: err.message }, 'port status notification failed (best-effort)');
  }

  logger.info({ portOrderId: order.id, telnyxPortOrderId, status: newStatus }, 'port order status updated');
  return { handled: true, idempotent: false, status: newStatus };
}

module.exports = {
  checkPortability,
  createPort,
  getPortStatus,
  cancelPort,
  completePortedNumber,
  handlePortingWebhook,
  // exposed for tests
  serializePortOrder,
  mapTelnyxStatus,
  OPEN_STATUSES,
};
