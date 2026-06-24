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
    sms_count, plan_data_cap_mb, overage_mb, overage_charge, polled_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
  ON CONFLICT (account_id, period_start, period_end)
  DO UPDATE SET
    endpoint_id = EXCLUDED.endpoint_id,
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
  ];

  const result = await db.query(UPSERT_SQL, params);
  return result.rows[0];
}

/**
 * Poll every active account that has a BICS endpoint. Failures are isolated:
 * one account's error does not abort the batch.
 * @param {Date} [now] - injectable clock.
 * @returns {Promise<{ polled: number, succeeded: number, failed: number, errors: Array }>}
 */
async function pollAllActiveAccounts(now = new Date()) {
  const { rows: accounts } = await db.query(
    `SELECT id, bics_endpoint_id, plan
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
async function getUsageSummaryForPeriod(periodStart, periodEnd) {
  const result = await db.query(
    `SELECT
       COUNT(DISTINCT account_id)            AS total_accounts,
       COALESCE(SUM(data_total_mb), 0)       AS total_data_mb,
       COALESCE(SUM(overage_mb), 0)          AS total_overage_mb,
       COALESCE(SUM(overage_charge), 0)      AS total_overage_charges,
       COALESCE(SUM(sms_count), 0)           AS total_sms_counts
     FROM usage_records
     WHERE period_start >= $1 AND period_end <= $2`,
    [periodStart, periodEnd],
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

module.exports = {
  PLAN_CAPS,
  pollUsageForAccount,
  pollAllActiveAccounts,
  getUsageForAccount,
  getUsageSummaryForPeriod,
};
