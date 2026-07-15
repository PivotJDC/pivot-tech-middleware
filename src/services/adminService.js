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
  // Tenant scope (omitted => all tenants, for super_admin cross-tenant view).
  if (filters.tenantId) { params.push(filters.tenantId); conditions.push(`tenant_id = $${params.length}`); }
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
  if (filters.tenantId) { params.push(filters.tenantId); conditions.push(`tenant_id = $${params.length}`); }
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
  // port_requests has no tenant_id; scope via the owning account.
  if (filters.tenantId) {
    params.push(filters.tenantId);
    conditions.push(`account_id IN (SELECT id FROM accounts WHERE tenant_id = $${params.length})`);
  }
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

/** Strip the encrypted account number + PIN from a port_orders row. */
function serializePortOrder(row) {
  if (!row) return null;
  const {
    // eslint-disable-next-line camelcase, no-unused-vars
    account_number_encrypted, pin_encrypted, ...safe
  } = row;
  return safe;
}

/**
 * Paginated FastPort port_orders list with status filter. Tenant-scoped via the
 * owning account (port_orders has no tenant_id). Secrets stripped.
 */
async function listPortOrders(filters = {}) {
  const { limit, offset } = paginate(filters);
  const conditions = [];
  const params = [];
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  if (filters.tenantId) {
    params.push(filters.tenantId);
    conditions.push(`account_id IN (SELECT id FROM accounts WHERE tenant_id = $${params.length})`);
  }
  const where = whereClause(conditions);

  const { total } = (await db.query(`SELECT COUNT(*)::int AS total FROM port_orders ${where}`, params))
    .rows[0];
  const pageParams = params.concat([limit, offset]);
  const { rows } = await db.query(
    `SELECT * FROM port_orders ${where}
       ORDER BY created_at DESC
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  return { port_orders: rows.map(serializePortOrder), pagination: { limit, offset, total } };
}

/**
 * One port order by id (secrets stripped). Tenant-scoped so a tenant admin can't
 * read another tenant's port. Throws NOT_FOUND when absent or out of scope.
 */
async function getPortOrder(id, tenantId) {
  const params = [id];
  let where = 'WHERE id = $1';
  if (tenantId) {
    params.push(tenantId);
    where += ' AND account_id IN (SELECT id FROM accounts WHERE tenant_id = $2)';
  }
  const { rows } = await db.query(`SELECT * FROM port_orders ${where}`, params);
  if (rows.length === 0) throw errors.notFound('Port order not found.');
  return serializePortOrder(rows[0]);
}

function countsByStatus(rows) {
  return rows.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {});
}

/** Operational metrics: active accounts, port success rate, DID inventory. */
async function getMetrics(tenantId) {
  const p = tenantId ? [tenantId] : [];
  const acctWhere = tenantId ? 'WHERE tenant_id = $1' : '';
  const didWhere = tenantId ? 'WHERE tenant_id = $1' : '';
  // port_requests has no tenant_id; scope via the owning account.
  const portWhere = tenantId ? 'WHERE account_id IN (SELECT id FROM accounts WHERE tenant_id = $1)' : '';

  const accountRows = (await db.query(
    `SELECT status, COUNT(*)::int AS count FROM accounts ${acctWhere} GROUP BY status`,
    p,
  )).rows;
  const portRows = (await db.query(
    `SELECT status, COUNT(*)::int AS count FROM port_requests ${portWhere} GROUP BY status`,
    p,
  )).rows;
  const didRows = (await db.query(
    `SELECT status, COUNT(*)::int AS count FROM dids ${didWhere} GROUP BY status`,
    p,
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

// Flagship MobilityNet plan price ($/month). MRR = active subscribers × this.
const PLAN_MONTHLY_PRICE = 25;

/**
 * Revenue & margin inputs for the current calendar month: active subscriber
 * count, MRR, and the usage volumes (voice minutes, data GB, SMS/MMS counts)
 * that the admin's cost rates are applied to client-side. Tenant-scoped.
 *
 * Data usage takes the LATEST snapshot per account this month (usage_records are
 * periodic cumulative snapshots — summing every poll would multiply-count).
 * Messages have no tenant_id column, so they scope via the owning account.
 * @returns {Promise<{ subscribers, mrr, voice_minutes, data_gb, sms_count,
 *   mms_count, period_start, period_end }>}
 */
async function getMarginMetrics(tenantId) {
  const t = tenantId ? ' AND tenant_id = $1' : '';
  const p = tenantId ? [tenantId] : [];

  // Active subscribers + MRR + the reporting window (from the DB clock).
  const subsRow = (await db.query(
    `SELECT COUNT(*)::int AS subscribers,
            date_trunc('month', now()) AS period_start,
            now() AS period_end
       FROM accounts
      WHERE status = 'active'${t}`,
    p,
  )).rows[0];
  const { subscribers } = subsRow;

  // Voice minutes this month (sum of call durations).
  const voiceSecs = (await db.query(
    `SELECT COALESCE(SUM(duration_seconds), 0)::bigint AS secs
       FROM call_records
      WHERE created_at >= date_trunc('month', now())${t}`,
    p,
  )).rows[0].secs;

  // Data GB this month — latest snapshot per account (avoid double-counting).
  const dataMb = (await db.query(
    `SELECT COALESCE(SUM(data_total_mb), 0) AS mb FROM (
        SELECT DISTINCT ON (account_id) data_total_mb
          FROM usage_records
         WHERE polled_at >= date_trunc('month', now())${t}
         ORDER BY account_id, period_start DESC, polled_at DESC
     ) latest`,
    p,
  )).rows[0].mb;

  // Outbound SMS/MMS this month. MMS = has media; SMS = no media.
  const msgParams = tenantId ? [tenantId] : [];
  const msgScope = tenantId
    ? ' AND account_id IN (SELECT id FROM accounts WHERE tenant_id = $1)'
    : '';
  const msg = (await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE cardinality(media_urls) = 0)::int AS sms_count,
        COUNT(*) FILTER (WHERE cardinality(media_urls) > 0)::int AS mms_count
       FROM messages
      WHERE direction = 'outbound'
        AND created_at >= date_trunc('month', now())${msgScope}`,
    msgParams,
  )).rows[0];

  return {
    subscribers,
    mrr: subscribers * PLAN_MONTHLY_PRICE,
    voice_minutes: Math.round(Number(voiceSecs) / 60),
    data_gb: Number((Number(dataMb) / 1024).toFixed(3)),
    sms_count: msg.sms_count,
    mms_count: msg.mms_count,
    period_start: subsRow.period_start,
    period_end: subsRow.period_end,
  };
}

/**
 * SQL fragment: `<col>` falls within the [from,to] window carried by params
 * $1 (from) / $2 (to). Either bound may be NULL, in which case it defaults to
 * the current calendar month. `to` is inclusive of the whole day.
 */
function periodClause(col) {
  return `${col} >= COALESCE($1::date, date_trunc('month', now()))`
    + ` AND ${col} < (COALESCE($2::date, now())::date + interval '1 day')`;
}

/** Param array for a date-ranged query: [from, to] (+ tenantId as $3). */
function periodParams(range, tenantId) {
  const r = range || {};
  const p = [r.from || null, r.to || null];
  if (tenantId) p.push(tenantId);
  return p;
}

/**
 * Per-vendor usage volumes so the admin Revenue & Margin view can apply each
 * vendor's own cost rates (BICS, Telnyx, Acrobits) client-side. Voice and
 * SMS/MMS are split by direction (Telnyx bills inbound/outbound differently).
 *
 * Each vendor bills on its own cycle, so its usage is fetched for its OWN date
 * range (`ranges.{bics,telnyx,acrobits}.{from,to}`, YYYY-MM-DD). A missing range
 * defaults to the current calendar month. Snapshot counts (active subscribers,
 * active SIMs, active DIDs) are point-in-time and not date-filtered.
 * Tenant-scoped. Returns:
 *   { bics: { active_sims, new_sims_this_month, data_mb },
 *     telnyx: { inbound_voice_minutes, outbound_voice_minutes,
 *               sms_inbound_count, sms_outbound_count,
 *               mms_inbound_count, mms_outbound_count, active_dids },
 *     acrobits: { active_users },
 *     subscribers, mrr }
 */
async function getVendorCosts(tenantId, ranges = {}) {
  // Snapshot queries: tenant param is $1.
  const t = tenantId ? ' AND tenant_id = $1' : '';
  const snap = tenantId ? [tenantId] : [];
  // Date-ranged queries: from/to are $1/$2, tenant is $3.
  const tr = tenantId ? ' AND tenant_id = $3' : '';

  // Active subscribers + MRR (snapshot).
  const { subscribers } = (await db.query(
    `SELECT COUNT(*)::int AS subscribers FROM accounts WHERE status = 'active'${t}`,
    snap,
  )).rows[0];

  // BICS: active SIMs (snapshot) + new SIMs within the BICS period.
  const sims = (await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE bics_endpoint_id IS NOT NULL)::int AS active_sims,
        COUNT(*) FILTER (
          WHERE bics_endpoint_id IS NOT NULL AND ${periodClause('created_at')}
        )::int AS new_sims
       FROM accounts
      WHERE TRUE${tr}`,
    periodParams(ranges.bics, tenantId),
  )).rows[0];

  // BICS: data usage in the BICS period — latest snapshot per account.
  const dataMb = (await db.query(
    `SELECT COALESCE(SUM(data_total_mb), 0) AS mb FROM (
        SELECT DISTINCT ON (account_id) data_total_mb
          FROM usage_records
         WHERE ${periodClause('polled_at')}${tr}
         ORDER BY account_id, period_start DESC, polled_at DESC
     ) latest`,
    periodParams(ranges.bics, tenantId),
  )).rows[0].mb;

  // Telnyx: voice minutes in the Telnyx period, split by direction.
  const voice = (await db.query(
    `SELECT
        COALESCE(SUM(duration_seconds) FILTER (WHERE direction = 'inbound'), 0)::bigint AS inbound_secs,
        COALESCE(SUM(duration_seconds) FILTER (WHERE direction = 'outbound'), 0)::bigint AS outbound_secs
       FROM call_records
      WHERE ${periodClause('created_at')}${tr}`,
    periodParams(ranges.telnyx, tenantId),
  )).rows[0];

  // Telnyx: SMS/MMS in the Telnyx period, split by direction × media (messages
  // have no tenant_id → scope via the owning account).
  const msgScope = tenantId
    ? ' AND account_id IN (SELECT id FROM accounts WHERE tenant_id = $3)'
    : '';
  const msg = (await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE direction = 'inbound'  AND cardinality(media_urls) = 0)::int AS sms_inbound,
        COUNT(*) FILTER (WHERE direction = 'outbound' AND cardinality(media_urls) = 0)::int AS sms_outbound,
        COUNT(*) FILTER (WHERE direction = 'inbound'  AND cardinality(media_urls) > 0)::int AS mms_inbound,
        COUNT(*) FILTER (WHERE direction = 'outbound' AND cardinality(media_urls) > 0)::int AS mms_outbound
       FROM messages
      WHERE ${periodClause('created_at')}${msgScope}`,
    periodParams(ranges.telnyx, tenantId),
  )).rows[0];

  // Telnyx: active DIDs (snapshot — assigned numbers we pay rental/CNAM/E911 on).
  const activeDids = (await db.query(
    `SELECT COUNT(*)::int AS count FROM dids WHERE status = 'assigned'${t}`,
    snap,
  )).rows[0].count;

  // Acrobits: users with dialer traffic (a call OR an outbound message) within
  // the Acrobits period.
  const activeUsers = (await db.query(
    `SELECT COUNT(*)::int AS active_users
       FROM accounts a
      WHERE (
        EXISTS (
          SELECT 1 FROM call_records c
           WHERE c.account_id = a.id AND ${periodClause('c.created_at')}
        )
        OR EXISTS (
          SELECT 1 FROM messages m
           WHERE m.account_id = a.id AND m.direction = 'outbound'
             AND ${periodClause('m.created_at')}
        )
      )${tr}`,
    periodParams(ranges.acrobits, tenantId),
  )).rows[0].active_users;

  return {
    bics: {
      active_sims: sims.active_sims,
      new_sims_this_month: sims.new_sims,
      data_mb: Number(Number(dataMb).toFixed(3)),
    },
    telnyx: {
      inbound_voice_minutes: Math.round(Number(voice.inbound_secs) / 60),
      outbound_voice_minutes: Math.round(Number(voice.outbound_secs) / 60),
      sms_inbound_count: msg.sms_inbound,
      sms_outbound_count: msg.sms_outbound,
      mms_inbound_count: msg.mms_inbound,
      mms_outbound_count: msg.mms_outbound,
      active_dids: activeDids,
    },
    acrobits: {
      active_users: activeUsers,
    },
    subscribers,
    mrr: subscribers * PLAN_MONTHLY_PRICE,
  };
}

/**
 * Usage stats for one account: the latest data snapshot (usage_records) plus
 * this calendar month's voice/SMS/MMS totals (call_records + message_records),
 * in a single round-trip. Missing data yields zeros (never null).
 * @returns {Promise<{ data_used_mb, data_cap_mb, voice_minutes, sms_count, mms_count }>}
 */
async function getAccountUsageStats(accountId, tenantId) {
  const t = tenantId ? ' AND tenant_id = $2' : '';
  const params = tenantId ? [accountId, tenantId] : [accountId];
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
        WHERE account_id = base.account_id${t}
        ORDER BY period_start DESC, polled_at DESC
        LIMIT 1
     ) u ON TRUE
     LEFT JOIN LATERAL (
       SELECT FLOOR(COALESCE(SUM(duration_seconds), 0) / 60.0)::int AS voice_minutes
         FROM call_records
        WHERE account_id = base.account_id${t}
          AND created_at >= date_trunc('month', now())
     ) c ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE message_type = 'sms') AS sms_count,
              COUNT(*) FILTER (WHERE message_type = 'mms') AS mms_count
         FROM message_records
        WHERE account_id = base.account_id${t}
          AND created_at >= date_trunc('month', now())
     ) m ON TRUE`,
    params,
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

/**
 * Network activity by hour of day (0-23) for the current calendar month:
 * call + message counts bucketed by EXTRACT(HOUR FROM created_at). Always
 * returns all 24 hours (zero-filled), ordered 0..23.
 * @returns {Promise<Array<{ hour, calls, messages }>>}
 */
async function getHourlyActivity(tenantId) {
  const t = tenantId ? ' AND tenant_id = $1' : '';
  const params = tenantId ? [tenantId] : [];
  const { rows } = await db.query(
    `SELECT h.hour AS hour,
            COALESCE(c.calls, 0)    AS calls,
            COALESCE(m.messages, 0) AS messages
       FROM generate_series(0, 23) AS h(hour)
       LEFT JOIN (
         SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*) AS calls
           FROM call_records
          WHERE created_at >= date_trunc('month', now())${t}
          GROUP BY 1
       ) c ON c.hour = h.hour
       LEFT JOIN (
         SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*) AS messages
           FROM message_records
          WHERE created_at >= date_trunc('month', now())${t}
          GROUP BY 1
       ) m ON m.hour = h.hour
      ORDER BY h.hour`,
    params,
  );
  return rows.map((r) => ({
    hour: Number(r.hour),
    calls: Number(r.calls),
    messages: Number(r.messages),
  }));
}

/**
 * Subscriber data-usage distribution: count of subscribers whose latest usage
 * snapshot falls into each GB bucket. One row per subscriber (their most recent
 * usage_records period). Always returns all six buckets in order, zero-filled.
 * @returns {Promise<Array<{ bucket, count }>>}
 */
async function getUsageDistribution(tenantId) {
  const t = tenantId ? 'WHERE tenant_id = $1' : '';
  const params = tenantId ? [tenantId] : [];
  const { rows } = await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (account_id) account_id, data_total_mb
         FROM usage_records
         ${t}
        ORDER BY account_id, period_start DESC, polled_at DESC
     )
     SELECT b.bucket AS bucket, COALESCE(cnt.count, 0) AS count
       FROM (VALUES
         (1, '0-1 GB'), (2, '1-5 GB'), (3, '5-10 GB'),
         (4, '10-20 GB'), (5, '20-30 GB'), (6, '30+ GB')
       ) AS b(ord, bucket)
       LEFT JOIN (
         SELECT
           CASE
             WHEN data_total_mb < 1024  THEN '0-1 GB'
             WHEN data_total_mb < 5120  THEN '1-5 GB'
             WHEN data_total_mb < 10240 THEN '5-10 GB'
             WHEN data_total_mb < 20480 THEN '10-20 GB'
             WHEN data_total_mb < 30720 THEN '20-30 GB'
             ELSE '30+ GB'
           END AS bucket,
           COUNT(*) AS count
           FROM latest
          GROUP BY 1
       ) cnt ON cnt.bucket = b.bucket
      ORDER BY b.ord`,
    params,
  );
  return rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }));
}

/**
 * Voice minutes + call volume by hour of day (0-23) for the current month.
 * call_count doubles as a proxy for data activity (BICS gives no hourly data
 * granularity). Zero-filled across all 24 hours.
 * @returns {Promise<Array<{ hour, voice_minutes, call_count }>>}
 */
async function getHourlyDataVoice(tenantId) {
  const t = tenantId ? ' AND tenant_id = $1' : '';
  const params = tenantId ? [tenantId] : [];
  const { rows } = await db.query(
    `SELECT h.hour AS hour,
            COALESCE(c.voice_minutes, 0) AS voice_minutes,
            COALESCE(c.call_count, 0)    AS call_count
       FROM generate_series(0, 23) AS h(hour)
       LEFT JOIN (
         SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
                FLOOR(COALESCE(SUM(duration_seconds), 0) / 60.0)::int AS voice_minutes,
                COUNT(*) AS call_count
           FROM call_records
          WHERE created_at >= date_trunc('month', now())${t}
          GROUP BY 1
       ) c ON c.hour = h.hour
      ORDER BY h.hour`,
    params,
  );
  return rows.map((r) => ({
    hour: Number(r.hour),
    voice_minutes: Number(r.voice_minutes),
    call_count: Number(r.call_count),
  }));
}

/**
 * Message volume by hour of day (0-23) split by direction for the current
 * month: sent (outbound) vs received (inbound). Zero-filled across 24 hours.
 * @returns {Promise<Array<{ hour, sent, received }>>}
 */
async function getHourlyMessages(tenantId) {
  const t = tenantId ? ' AND tenant_id = $1' : '';
  const params = tenantId ? [tenantId] : [];
  const { rows } = await db.query(
    `SELECT h.hour AS hour,
            COALESCE(m.sent, 0)     AS sent,
            COALESCE(m.received, 0) AS received
       FROM generate_series(0, 23) AS h(hour)
       LEFT JOIN (
         SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
                COUNT(*) FILTER (WHERE direction = 'outbound') AS sent,
                COUNT(*) FILTER (WHERE direction = 'inbound')  AS received
           FROM message_records
          WHERE created_at >= date_trunc('month', now())${t}
          GROUP BY 1
       ) m ON m.hour = h.hour
      ORDER BY h.hour`,
    params,
  );
  return rows.map((r) => ({
    hour: Number(r.hour),
    sent: Number(r.sent),
    received: Number(r.received),
  }));
}

// SQL fragments per trend period: how to bucket the label and how far back to
// look. Keyed by the validated `period` so user input never reaches the query.
const USAGE_TREND_PERIODS = {
  day: { label: 'period_end', since: "now() - interval '30 days'" },
  week: { label: "date_trunc('week', period_end)::date", since: "now() - interval '12 weeks'" },
  month: { label: "date_trunc('month', period_end)::date", since: "now() - interval '12 months'" },
};

/**
 * Total subscriber data usage over time, bucketed by day (last 30), ISO week
 * (last 12), or month (last 12). Returns rows oldest-first.
 * @param {'day'|'week'|'month'} [period='day']
 * @returns {Promise<Array<{ label: string, total_mb: number }>>}
 */
async function getUsageTrends(period, tenantId) {
  const spec = USAGE_TREND_PERIODS[period] || USAGE_TREND_PERIODS.day; // undefined -> day
  const t = tenantId ? ' AND tenant_id = $1' : '';
  const params = tenantId ? [tenantId] : [];
  const { rows } = await db.query(
    `SELECT ${spec.label} AS label, SUM(data_total_mb) AS total_mb
       FROM usage_records
      WHERE period_end >= ${spec.since}${t}
      GROUP BY 1
      ORDER BY 1`,
    params,
  );
  return rows.map((r) => ({
    // period_end / date_trunc(...)::date come back as Date objects; normalize to
    // a YYYY-MM-DD label string.
    label: r.label instanceof Date ? r.label.toISOString().slice(0, 10) : String(r.label),
    total_mb: Number(r.total_mb) || 0,
  }));
}

// Blended $/GB fallback when no per-carrier BICS cost is available. Rough MVP
// estimate; refine once BICS wholesale rates are wired in.
const BLENDED_DATA_RATE_PER_GB = 2.0;

/**
 * Billing reconciliation for a date range: Telnyx-side voice/SMS/MMS volumes
 * (call_records + message_records, by created_at) alongside BICS-side data
 * usage (usage_records, by period). `from`/`to` are YYYY-MM-DD strings; the
 * range is inclusive.
 * @param {string} from
 * @param {string} to
 */
async function getBillingReconciliation(from, to, tenantId) {
  const tf = tenantId ? ' AND tenant_id = $3' : '';
  const params = tenantId ? [from, to, tenantId] : [from, to];
  const [telnyxRes, bicsRes] = await Promise.all([
    db.query(
      `SELECT
         (SELECT COALESCE(FLOOR(SUM(duration_seconds) / 60.0), 0)::int
            FROM call_records
           WHERE created_at BETWEEN $1::date AND ($2::date + interval '1 day')${tf})               AS voice_minutes,
         (SELECT COUNT(*) FROM call_records
           WHERE created_at BETWEEN $1::date AND ($2::date + interval '1 day')${tf})               AS voice_calls,
         (SELECT COUNT(*) FROM message_records
           WHERE created_at BETWEEN $1::date AND ($2::date + interval '1 day')${tf}
             AND message_type = 'sms')                            AS sms_count,
         (SELECT COUNT(*) FROM message_records
           WHERE created_at BETWEEN $1::date AND ($2::date + interval '1 day')${tf}
             AND message_type = 'mms')                            AS mms_count`,
      params,
    ),
    db.query(
      `SELECT COALESCE(SUM(data_total_mb), 0) AS data_total_mb,
              COALESCE(SUM(data_cost), 0)     AS data_cost
         FROM usage_records
        WHERE period_start >= $1::date AND period_end <= ($2::date + interval '1 day')${tf}`,
      params,
    ),
  ]);

  const t = telnyxRes.rows[0] || {};
  const b = bicsRes.rows[0] || {};
  const dataTotalMb = Number(b.data_total_mb) || 0;
  const dataTotalGb = Math.round((dataTotalMb / 1024) * 100) / 100;
  // Prefer the carrier's own reported cost; fall back to the blended $/GB rate.
  const carrierCost = Number(b.data_cost) || 0;
  const estimatedCost = carrierCost > 0
    ? Math.round(carrierCost * 100) / 100
    : Math.round((dataTotalMb / 1024) * BLENDED_DATA_RATE_PER_GB * 100) / 100;

  return {
    period: { from, to },
    telnyx: {
      voice_minutes: Number(t.voice_minutes) || 0,
      voice_calls: Number(t.voice_calls) || 0,
      sms_count: Number(t.sms_count) || 0,
      mms_count: Number(t.mms_count) || 0,
    },
    bics: {
      data_total_mb: dataTotalMb,
      data_total_gb: dataTotalGb,
      estimated_cost: estimatedCost,
    },
  };
}

module.exports = {
  listAccounts,
  listDids,
  listPorts,
  listPortOrders,
  getPortOrder,
  retryPort,
  getMetrics,
  getMarginMetrics,
  getVendorCosts,
  getAccountUsageStats,
  getHourlyActivity,
  getUsageDistribution,
  getHourlyDataVoice,
  getHourlyMessages,
  getUsageTrends,
  getBillingReconciliation,
  serializePort,
};
