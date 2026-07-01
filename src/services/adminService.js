/**
 * Admin service — read models, metrics, and operational actions for the admin
 * API. Keeps SQL out of the route handlers and strips secrets from every row
 * returned (sip_password_hash from accounts, pin_encrypted from port_requests).
 */
const db = require('../db');
const { errors } = require('../middleware/errorHandler');
const { serializeAccount } = require('./accountService');
const portOrchestration = require('./portOrchestrationService');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function paginate(filters) {
  const rawLimit = Number.parseInt(filters.limit, 10);
  const rawOffset = Number.parseInt(filters.offset, 10);
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit, 1), MAX_LIMIT);
  const offset = Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0);
  return { limit, offset };
}

function whereClause(conditions) {
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
}

/** Strip the encrypted PIN from a port_requests row before returning it. */
function serializePort(row) {
  if (!row) return row;
  // eslint-disable-next-line camelcase, no-unused-vars
  const { pin_encrypted, ...safe } = row;
  return safe;
}

/** Paginated account list with status/market/date filters. */
async function listAccounts(filters = {}) {
  const { limit, offset } = paginate(filters);
  const conditions = [];
  const params = [];
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  if (filters.market) { params.push(filters.market); conditions.push(`market = $${params.length}`); }
  if (filters.from) { params.push(filters.from); conditions.push(`created_at >= $${params.length}`); }
  if (filters.to) { params.push(filters.to); conditions.push(`created_at <= $${params.length}`); }
  // Free-text search across email + phone (case-insensitive substring).
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(`(email ILIKE $${params.length} OR phone_e164 ILIKE $${params.length})`);
  }
  const where = whereClause(conditions);

  const { total } = (await db.query(`SELECT COUNT(*)::int AS total FROM accounts ${where}`, params))
    .rows[0];
  const pageParams = params.concat([limit, offset]);
  const { rows } = await db.query(
    `SELECT * FROM accounts ${where}
       ORDER BY created_at DESC
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  return { accounts: rows.map(serializeAccount), pagination: { limit, offset, total } };
}

/** Paginated DID inventory with market/status/area_code filters. */
async function listDids(filters = {}) {
  const { limit, offset } = paginate(filters);
  const conditions = [];
  const params = [];
  if (filters.market) { params.push(filters.market); conditions.push(`market = $${params.length}`); }
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  if (filters.area_code) { params.push(filters.area_code); conditions.push(`area_code = $${params.length}`); }
  // Free-text search by phone number (case-insensitive substring on e164).
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(`e164 ILIKE $${params.length}`);
  }
  const where = whereClause(conditions);

  const { total } = (await db.query(`SELECT COUNT(*)::int AS total FROM dids ${where}`, params))
    .rows[0];
  const pageParams = params.concat([limit, offset]);
  const { rows } = await db.query(
    `SELECT * FROM dids ${where}
       ORDER BY created_at DESC
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  return { dids: rows, pagination: { limit, offset, total } };
}

/** Paginated port-request list with status/carrier filters (PIN stripped). */
async function listPorts(filters = {}) {
  const { limit, offset } = paginate(filters);
  const conditions = [];
  const params = [];
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  if (filters.carrier) { params.push(filters.carrier); conditions.push(`losing_carrier = $${params.length}`); }
  const where = whereClause(conditions);

  const { total } = (await db.query(`SELECT COUNT(*)::int AS total FROM port_requests ${where}`, params))
    .rows[0];
  const pageParams = params.concat([limit, offset]);
  const { rows } = await db.query(
    `SELECT * FROM port_requests ${where}
       ORDER BY created_at DESC
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  return { ports: rows.map(serializePort), pagination: { limit, offset, total } };
}

/**
 * Resubmit a failed port to SignalWire. Only ports in 'failed' status may be
 * retried. Returns the updated (PIN-stripped) port row.
 */
async function retryPort(portId) {
  const { rows } = await db.query('SELECT * FROM port_requests WHERE id = $1', [portId]);
  if (rows.length === 0) {
    throw errors.notFound('Port request not found.');
  }
  const port = rows[0];
  if (port.status !== 'failed') {
    throw errors.validation(`Only failed ports can be retried (current: ${port.status}).`, 'status');
  }

  const { signalwirePortId } = await portOrchestration.submitPortToSignalwire(port);

  const updated = (await db.query(
    `UPDATE port_requests
        SET status = 'submitted',
            signalwire_port_id = COALESCE($2, signalwire_port_id),
            submitted_at = NOW(),
            failure_reason = NULL
      WHERE id = $1
      RETURNING *`,
    [portId, signalwirePortId],
  )).rows[0];

  return serializePort(updated);
}

function countsByStatus(rows) {
  return rows.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {});
}

/** Operational metrics: active accounts, port success rate, DID inventory. */
async function getMetrics() {
  const accountRows = (await db.query(
    'SELECT status, COUNT(*)::int AS count FROM accounts GROUP BY status',
  )).rows;
  const portRows = (await db.query(
    'SELECT status, COUNT(*)::int AS count FROM port_requests GROUP BY status',
  )).rows;
  const didRows = (await db.query(
    'SELECT status, COUNT(*)::int AS count FROM dids GROUP BY status',
  )).rows;

  const accounts = countsByStatus(accountRows);
  const ports = countsByStatus(portRows);
  const dids = countsByStatus(didRows);

  const completed = ports.completed || 0;
  const failed = ports.failed || 0;
  const finished = completed + failed;
  const successRate = finished === 0 ? null : Number((completed / finished).toFixed(4));

  return {
    accounts: {
      total: Object.values(accounts).reduce((a, b) => a + b, 0),
      active: accounts.active || 0,
      pending: accounts.pending || 0,
      suspended: accounts.suspended || 0,
      cancelled: accounts.cancelled || 0,
    },
    ports: {
      total: Object.values(ports).reduce((a, b) => a + b, 0),
      completed,
      failed,
      success_rate: successRate,
    },
    dids: {
      total: Object.values(dids).reduce((a, b) => a + b, 0),
      available: dids.available || 0,
      assigned: dids.assigned || 0,
      by_status: dids,
    },
  };
}

/**
 * Usage stats for one account: the latest data snapshot (usage_records) plus
 * this calendar month's voice/SMS/MMS totals (call_records + message_records),
 * in a single round-trip. Missing data yields zeros (never null).
 * @returns {Promise<{ data_used_mb, data_cap_mb, voice_minutes, sms_count, mms_count }>}
 */
async function getAccountUsageStats(accountId) {
  const { rows } = await db.query(
    `SELECT
       COALESCE(u.data_total_mb, 0)    AS data_used_mb,
       COALESCE(u.plan_data_cap_mb, 0) AS data_cap_mb,
       COALESCE(c.voice_minutes, 0)    AS voice_minutes,
       COALESCE(m.sms_count, 0)        AS sms_count,
       COALESCE(m.mms_count, 0)        AS mms_count
     FROM (SELECT $1::uuid AS account_id) base
     LEFT JOIN LATERAL (
       SELECT data_total_mb, plan_data_cap_mb
         FROM usage_records
        WHERE account_id = base.account_id
        ORDER BY period_start DESC, polled_at DESC
        LIMIT 1
     ) u ON TRUE
     LEFT JOIN LATERAL (
       SELECT FLOOR(COALESCE(SUM(duration_seconds), 0) / 60.0)::int AS voice_minutes
         FROM call_records
        WHERE account_id = base.account_id
          AND created_at >= date_trunc('month', now())
     ) c ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE message_type = 'sms') AS sms_count,
              COUNT(*) FILTER (WHERE message_type = 'mms') AS mms_count
         FROM message_records
        WHERE account_id = base.account_id
          AND created_at >= date_trunc('month', now())
     ) m ON TRUE`,
    [accountId],
  );
  const r = rows[0] || {};
  return {
    data_used_mb: Number(r.data_used_mb) || 0,
    data_cap_mb: Number(r.data_cap_mb) || 0,
    voice_minutes: Number(r.voice_minutes) || 0,
    sms_count: Number(r.sms_count) || 0,
    mms_count: Number(r.mms_count) || 0,
  };
}

module.exports = {
  listAccounts,
  listDids,
  listPorts,
  retryPort,
  getMetrics,
  getAccountUsageStats,
  serializePort,
};
