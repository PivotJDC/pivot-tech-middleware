/**
 * Usage service — polls BICS for per-subscriber data usage and persists it to
 * usage_records.
 *
 * The poller computes the current calendar-month billing period (1st → today),
 * pulls totals from BICS, derives overage against the plan's data cap, and
 * UPSERTs one row per (account, period). Re-polling the same period overwrites
 * the metrics in place. Routes / scheduled jobs call into here; this module
 * never touches HTTP.
 */
const db = require('../db');
const bics = require('../integrations/bics');
const { DEFAULT_TENANT_ID } = require('./tenantService');
const { logger } = require('../utils/logger');

// Plan economics. capMb is the full-speed allowance; overagePerGb is the $/GB
// charged beyond it; throttled plans slow down instead of billing overage.
// Keep the slugs in sync with accountService PLANS and the dashboard lib/plans.
const PLAN_CAPS = {
  starter_10: { capMb: 1024, overagePerGb: 2.00, throttled: false },
  unlimited_25: { capMb: 30720, overagePerGb: 0, throttled: true },
  unlimited_25_plus: { capMb: 30720, overagePerGb: 2.00, throttled: false },
};

/** Coerce a BICS string/number value to a finite number (0 on garbage). */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Round to a fixed number of decimal places. */
function round(value, dp) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Which usage-notification thresholds a subscriber has NEWLY crossed: returns
 * the levels ('80'|'90'|'100') where usage is at/over the percentage AND the
 * corresponding notified_* flag is not already set. Pure — no I/O.
 * @param {number} totalMb - usage this period.
 * @param {number} capMb - the plan's data cap.
 * @param {{ notified_80?, notified_90?, notified_100? }} [flags] - current row flags.
 * @returns {string[]}
 */
function newThresholdFlags(totalMb, capMb, flags = {}) {
  if (!capMb || capMb <= 0) return [];
  const pct = totalMb / capMb;
  const crossed = [];
  if (pct >= 0.8 && !flags.notified_80) crossed.push('80');
  if (pct >= 0.9 && !flags.notified_90) crossed.push('90');
  if (pct >= 1.0 && !flags.notified_100) crossed.push('100');
  return crossed;
}

/**
 * Current billing period for a given instant, computed in UTC so the result is
 * timezone-independent. Returns both the DB date strings (YYYY-MM-DD) and the
 * BICS query strings (YYYYMMDD).
 */
function billingPeriod(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  const d = now.getUTCDate();

  const startIso = `${y}-${pad2(m + 1)}-01`;
  const endIso = `${y}-${pad2(m + 1)}-${pad2(d)}`;
  return {
    periodStart: startIso,
    periodEnd: endIso,
    fromDate: `${y}${pad2(m + 1)}01`,
    toDate: `${y}${pad2(m + 1)}${pad2(d)}`,
  };
}

const UPSERT_SQL = `
  INSERT INTO usage_records (
    account_id, endpoint_id, period_start, period_end,
    data_uplink_mb, data_downlink_mb, data_total_mb, data_cost,
    sms_count, plan_data_cap_mb, overage_mb, overage_charge, tenant_id, polled_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
  ON CONFLICT (account_id, period_start, period_end)
  DO UPDATE SET
    endpoint_id = EXCLUDED.endpoint_id,
    tenant_id = EXCLUDED.tenant_id,
    data_uplink_mb = EXCLUDED.data_uplink_mb,
    data_downlink_mb = EXCLUDED.data_downlink_mb,
    data_total_mb = EXCLUDED.data_total_mb,
    data_cost = EXCLUDED.data_cost,
    sms_count = EXCLUDED.sms_count,
    plan_data_cap_mb = EXCLUDED.plan_data_cap_mb,
    overage_mb = EXCLUDED.overage_mb,
    overage_charge = EXCLUDED.overage_charge,
    polled_at = NOW()
  RETURNING *
`;

/**
 * Poll BICS for one account's current-period usage and UPSERT it.
 * @param {{ id: string, bics_endpoint_id: string, plan: string }} account
 * @param {Date} [now] - injectable clock for the billing-period calc/tests.
 * @returns {Promise<object>} the persisted usage_records row.
 */
async function pollUsageForAccount(account, now = new Date()) {
  if (!account || !account.bics_endpoint_id) {
    throw new Error(`account ${account && account.id} has no bics_endpoint_id`);
  }
  const planConfig = PLAN_CAPS[account.plan];
  if (!planConfig) {
    throw new Error(`unknown plan "${account.plan}" for account ${account.id}`);
  }

  const {
    periodStart, periodEnd, fromDate, toDate,
  } = billingPeriod(now);

  const stats = await bics.getEndpointStatistics(account.bics_endpoint_id, fromDate, toDate);
  const dataTotal = (stats && stats.dataTotalUsage) || {};
  const smsTotal = (stats && stats.smsTotalUsage) || {};

  const totalMb = num(dataTotal.totalVolume);
  const { capMb } = planConfig;
  const overageMb = round(Math.max(0, totalMb - capMb), 3);
  // Throttled plans (overagePerGb 0) bill nothing; overage_mb is still recorded.
  const overageCharge = round((overageMb / 1024) * planConfig.overagePerGb, 2);

  const params = [
    account.id,
    account.bics_endpoint_id,
    periodStart,
    periodEnd,
    round(num(dataTotal.uplink), 3),
    round(num(dataTotal.downlink), 3),
    round(totalMb, 3),
    round(num(dataTotal.totalCost), 3),
    Math.trunc(num(smsTotal.count)),
    capMb,
    overageMb,
    overageCharge,
    account.tenant_id || DEFAULT_TENANT_ID,
  ];

  const result = await db.query(UPSERT_SQL, params);
  const row = result.rows[0];

  // Usage-notification thresholds: set the flag(s) newly crossed this period and
  // log the crossing. No SMS/email yet — delivery is a follow-up; for now we
  // just persist the flag so we can see (and later act on) the crossing.
  const crossed = newThresholdFlags(totalMb, capMb, row);
  if (crossed.length === 0) return row;

  const setSql = crossed.map((lvl) => `notified_${lvl} = true`).join(', ');
  const updated = await db.query(
    `UPDATE usage_records SET ${setSql} WHERE id = $1 RETURNING *`,
    [row.id],
  );
  const pct = capMb > 0 ? Math.round((totalMb / capMb) * 100) : 0;
  crossed.forEach((lvl) => logger.warn(
    {
      accountId: account.id, usedMb: round(totalMb, 3), capMb, pct,
    },
    `usage threshold ${lvl}% crossed for account ${account.id}`,
  ));
  return updated.rows[0];
}

/**
 * Poll every active account that has a BICS endpoint. Failures are isolated:
 * one account's error does not abort the batch.
 * @param {Date} [now] - injectable clock.
 * @returns {Promise<{ polled: number, succeeded: number, failed: number, errors: Array }>}
 */
async function pollAllActiveAccounts(now = new Date()) {
  const { rows: accounts } = await db.query(
    `SELECT id, bics_endpoint_id, plan, tenant_id
       FROM accounts
      WHERE status = 'active' AND bics_endpoint_id IS NOT NULL`,
  );

  let succeeded = 0;
  const errors = [];

  // Sequential by design: keeps load on the BICS API gentle and ordering
  // predictable. Each account is isolated in its own try/catch.
  // eslint-disable-next-line no-restricted-syntax
  for (const account of accounts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await pollUsageForAccount(account, now);
      succeeded += 1;
    } catch (err) {
      errors.push({ accountId: account.id, error: err.message });
      logger.warn({ accountId: account.id, err: err.message }, 'usage poll failed for account');
    }
  }

  const summary = {
    polled: accounts.length,
    succeeded,
    failed: errors.length,
    errors,
  };
  logger.info(
    { polled: summary.polled, succeeded: summary.succeeded, failed: summary.failed },
    'usage poll batch complete',
  );
  return summary;
}

/**
 * Latest usage record for an account (drives the customer dashboard usage bar).
 * @param {string} accountId
 * @returns {Promise<object|null>}
 */
async function getUsageForAccount(accountId) {
  const result = await db.query(
    `SELECT * FROM usage_records
      WHERE account_id = $1
      ORDER BY period_end DESC, polled_at DESC
      LIMIT 1`,
    [accountId],
  );
  return result.rows[0] || null;
}

/**
 * Aggregate usage across all records that fall within [periodStart, periodEnd].
 * Used by the admin dashboard and the Gaiia billing export.
 * @param {string} periodStart - YYYY-MM-DD
 * @param {string} periodEnd - YYYY-MM-DD
 * @returns {Promise<object>} aggregate totals for the period.
 */
async function getUsageSummaryForPeriod(periodStart, periodEnd, tenantId) {
  const params = [periodStart, periodEnd];
  let where = 'period_start >= $1 AND period_end <= $2';
  if (tenantId) {
    params.push(tenantId);
    where += ` AND tenant_id = $${params.length}`;
  }
  const result = await db.query(
    `SELECT
       COUNT(DISTINCT account_id)            AS total_accounts,
       COALESCE(SUM(data_total_mb), 0)       AS total_data_mb,
       COALESCE(SUM(overage_mb), 0)          AS total_overage_mb,
       COALESCE(SUM(overage_charge), 0)      AS total_overage_charges,
       COALESCE(SUM(sms_count), 0)           AS total_sms_counts
     FROM usage_records
     WHERE ${where}`,
    params,
  );
  const row = result.rows[0] || {};
  return {
    totalAccounts: num(row.total_accounts),
    totalDataMb: num(row.total_data_mb),
    totalOverageMb: num(row.total_overage_mb),
    totalOverageCharges: num(row.total_overage_charges),
    totalSmsCounts: num(row.total_sms_counts),
  };
}

/**
 * Usage summary for the current billing period (1st of month → today, UTC),
 * optionally scoped to a tenant.
 * @param {{ now?: Date, tenantId?: string }} [opts]
 */
async function getCurrentPeriodSummary({ now = new Date(), tenantId } = {}) {
  const { periodStart, periodEnd } = billingPeriod(now);
  return getUsageSummaryForPeriod(periodStart, periodEnd, tenantId);
}

module.exports = {
  PLAN_CAPS,
  newThresholdFlags,
  pollUsageForAccount,
  pollAllActiveAccounts,
  getUsageForAccount,
  getUsageSummaryForPeriod,
  getCurrentPeriodSummary,
};
