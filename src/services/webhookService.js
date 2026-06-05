/**
 * Webhook service — validates and processes inbound SignalWire webhooks.
 *
 * Security: verifySignature() enforces the HMAC-SHA256 check (CLAUDE.md rule #5)
 * before any processing; the route rejects 403 on failure.
 *
 * Idempotency (CLAUDE.md rule #6): port events are keyed by signalwire_port_id.
 * All state changes happen inside a single transaction that re-reads the row
 * FOR UPDATE, so duplicate or out-of-order deliveries can never double-apply:
 *   - terminal states (completed/failed/cancelled) ignore further events
 *   - non-terminal events apply only when they move the port forward in rank
 *
 * NOTE (MVP tradeoff): on port.completed the external SignalWire campaign-assign
 * call runs inside the DB transaction. That holds the row lock for the call's
 * duration; acceptable at MVP webhook volume. TODO: move it out of the txn and
 * make it a retried step before commit when traffic grows.
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const signalwire = require('../integrations/signalwire');
const notificationService = require('./notificationService');
const { areaCodeOf } = require('../utils/e164');
const { logger } = require('../utils/logger');

const PORT_EVENT_STATUS = {
  'port.submitted': 'submitted',
  'port.approved': 'approved',
  'port.completed': 'completed',
  'port.failed': 'failed',
};

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const RANK = {
  pending: 0, submitted: 1, approved: 2, completed: 3,
};

/**
 * Validate an inbound webhook's HMAC-SHA256 signature against
 * SIGNALWIRE_WEBHOOK_SECRET, in constant time.
 * @param {Buffer|string} rawBody - the raw request body (pre-JSON-parse)
 * @param {string} signature - the x-signalwire-signature header (hex)
 * @returns {boolean}
 */
function verifySignature(rawBody, signature) {
  const secret = config.signalwire.webhookSecret;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(String(signature));
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function eventType(event) {
  return event && (event.type || event.event);
}

function portIdOf(data) {
  return data.port_id || data.id || data.signalwire_port_id;
}

function safeAreaCode(e164) {
  try {
    return areaCodeOf(e164);
  } catch (err) {
    const digits = String(e164).replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-10, -7) : '000';
  }
}

/**
 * Side effects for a completed port: assign the number to the market's 10DLC
 * campaign on SignalWire, then upsert the did, complete the port_request, and
 * point the account at its new number. Runs inside the caller's transaction.
 */
async function completePort(client, port, data) {
  const numberSid = data.number_sid || data.sid || null;

  const acct = (await client.query(
    'SELECT id, market FROM accounts WHERE id = $1',
    [port.account_id],
  )).rows[0];
  const market = acct ? acct.market : 'unknown';

  // Resolve the approved campaign for this market (if any).
  let internalCampaignId = null;
  let signalwireCampaignId = null;
  if (acct) {
    const campaign = (await client.query(
      `SELECT id, signalwire_campaign_id FROM tcr_campaigns
        WHERE market = $1 AND status = 'approved'
        ORDER BY created_at LIMIT 1`,
      [market],
    )).rows[0];
    if (campaign) {
      internalCampaignId = campaign.id;
      signalwireCampaignId = campaign.signalwire_campaign_id;
    }
  }

  // Assign the number to the 10DLC campaign on SignalWire.
  if (numberSid && signalwireCampaignId) {
    await signalwire.assignNumberToCampaign(numberSid, signalwireCampaignId);
  } else {
    logger.warn(
      {
        portId: port.signalwire_port_id,
        hasSid: Boolean(numberSid),
        hasCampaign: Boolean(signalwireCampaignId),
      },
      'port.completed: skipping campaign assignment (missing number sid or approved campaign)',
    );
  }

  // Complete the port request.
  await client.query(
    "UPDATE port_requests SET status = 'completed', completed_at = NOW() WHERE id = $1",
    [port.id],
  );

  // Upsert the DID record for the ported-in number.
  const existingDid = (await client.query(
    'SELECT id FROM dids WHERE e164 = $1',
    [port.number_e164],
  )).rows[0];
  if (existingDid) {
    await client.query(
      `UPDATE dids
          SET status = 'assigned', ported_in = TRUE, ported_in_at = NOW(),
              account_id = $2, campaign_id = $3,
              signalwire_sid = COALESCE($4, signalwire_sid)
        WHERE id = $1`,
      [existingDid.id, port.account_id, internalCampaignId, numberSid],
    );
  } else {
    await client.query(
      `INSERT INTO dids
         (e164, area_code, market, signalwire_sid, account_id, campaign_id,
          status, ported_in, ported_in_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'assigned', TRUE, NOW())`,
      [
        port.number_e164,
        safeAreaCode(port.number_e164),
        market,
        numberSid || 'pending',
        port.account_id,
        internalCampaignId,
      ],
    );
  }

  // Point the account at its newly-ported number.
  await client.query(
    'UPDATE accounts SET phone_e164 = $2 WHERE id = $1',
    [port.account_id, port.number_e164],
  );
}

/**
 * Process a port lifecycle webhook (port.submitted/approved/completed/failed).
 * Idempotent and order-safe. Returns a small result describing what happened.
 */
async function handlePortEvent(event) {
  const type = eventType(event);
  const data = (event && event.data) || {};
  const newStatus = PORT_EVENT_STATUS[type];

  if (!newStatus) {
    logger.warn({ type }, 'ignoring unknown port event type');
    return { handled: false, reason: 'unknown_event_type' };
  }
  const portId = portIdOf(data);
  if (!portId) {
    logger.warn({ type }, 'port event missing port id');
    return { handled: false, reason: 'missing_port_id' };
  }

  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM port_requests WHERE signalwire_port_id = $1 FOR UPDATE',
      [portId],
    );
    if (rows.length === 0) {
      logger.warn({ portId, type }, 'no port_request for signalwire_port_id; acking');
      return { handled: false, reason: 'unknown_port' };
    }
    const port = rows[0];

    // Idempotency / ordering guard.
    if (TERMINAL.has(port.status)) {
      return { handled: true, idempotent: true, status: port.status };
    }
    if (type === 'port.failed') {
      await client.query(
        "UPDATE port_requests SET status = 'failed', failure_reason = $2 WHERE id = $1",
        [port.id, data.reason || 'unknown'],
      );
      return {
        handled: true, idempotent: false, status: 'failed', notify: port.account_id,
      };
    }
    if ((RANK[newStatus] || 0) <= (RANK[port.status] || 0)) {
      // same or backwards event — no-op
      return { handled: true, idempotent: true, status: port.status };
    }
    if (type === 'port.submitted') {
      await client.query(
        "UPDATE port_requests SET status = 'submitted', submitted_at = NOW() WHERE id = $1",
        [port.id],
      );
    } else if (type === 'port.approved') {
      await client.query(
        "UPDATE port_requests SET status = 'approved' WHERE id = $1",
        [port.id],
      );
    } else {
      // port.completed
      await completePort(client, port, data);
      return {
        handled: true, idempotent: false, status: 'completed', notify: port.account_id,
      };
    }
    return { handled: true, idempotent: false, status: newStatus };
  });

  // Notifications fire after the transaction commits (stub for now).
  if (result.notify) {
    await notificationService.notify({ id: result.notify }, `${type}`);
  }
  return result;
}

/**
 * Process a general SignalWire event (calls, SMS/MMS delivery). MVP: log + ack;
 * specific handling is added as those flows are built out.
 */
async function handleSignalwireEvent(event) {
  logger.info({ type: eventType(event) }, 'signalwire general event received (MVP no-op)');
  return { handled: true };
}

module.exports = {
  verifySignature,
  handlePortEvent,
  handleSignalwireEvent,
  // exported for tests
  completePort,
};
