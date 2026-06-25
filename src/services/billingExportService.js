/**
 * Billing export service — turns usage_records into monthly billing data for a
 * downstream billing system (initially Gaiia, but the shape is generic).
 *
 * Each subscriber falls into one of two cases, signalled by the per-record
 * `action` field so the importer can route correctly:
 *   - "append": the account already exists downstream (accounts.external_billing_id
 *     is set) — add the mobile charges to it.
 *   - "create": a new/mobile-only customer (no external_billing_id) — a billing
 *     account must be created.
 *
 * Routes call into here; this module never touches HTTP. Money/usage values are
 * stored as Postgres NUMERIC and come back as strings, so everything is coerced
 * to numbers before arithmetic.
 */
const db = require('../db');

// Monthly base price per plan slug (USD). Keep in sync with the dashboard
// lib/plans.ts and accountService PLANS.
const PLAN_PRICES = {
  starter_10: 10,
  unlimited_25: 25,
  unlimited_25_plus: 25,
};

// $/GB charged on overage. Mirrors usageService PLAN_CAPS.overagePerGb:
// unlimited_25 is throttled (no overage charge), the others bill $2/GB.
const OVERAGE_RATES = {
  starter_10: 2.00,
  unlimited_25: 0,
  unlimited_25_plus: 2.00,
};

/** Coerce a NUMERIC string / value to a finite number (0 on garbage). */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Round to 2 decimal places (currency). */
function round2(value) {
  return Math.round(value * 100) / 100;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Resolve a year/month into the SQL half-open date range covering that month
 * and the "YYYY-MM" period label.
 */
function monthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    start: `${y}-${pad2(m)}-01`,
    end: `${nextY}-${pad2(nextM)}-01`,
    period: `${y}-${pad2(m)}`,
  };
}

// Columns selected for every billing query (usage_records joined to accounts,
// with a LEFT JOIN to the parent so child-line charges can roll up under the
// primary's billing account — see JOIN_CLAUSE).
const SELECT_COLUMNS = `
  ur.account_id, ur.endpoint_id, ur.data_total_mb, ur.plan_cap_mb,
  ur.overage_mb, ur.overage_charge,
  a.email, a.phone_e164, a.plan, a.status,
  a.external_billing_id, a.external_billing_provider, a.bics_iccid,
  a.parent_account_id,
  p.external_billing_id AS parent_external_billing_id,
  p.external_billing_provider AS parent_external_billing_provider
`;

const JOIN_CLAUSE = `
  JOIN accounts a ON a.id = ur.account_id
  LEFT JOIN accounts p ON p.id = a.parent_account_id
`;

/** Map a joined usage+account row into a billing record. */
function buildRecord(row, period) {
  const { plan } = row;
  const baseCharge = PLAN_PRICES[plan] || 0;
  const overageMb = num(row.overage_mb);
  const overageCharge = round2(num(row.overage_charge));
  const parentAccountId = row.parent_account_id || null;
  // Child lines roll up under the primary's external billing id/provider so the
  // downstream system consolidates the family's charges onto one account.
  const externalBillingId = parentAccountId
    ? (row.parent_external_billing_id || null)
    : (row.external_billing_id || null);
  const externalBillingProvider = parentAccountId
    ? (row.parent_external_billing_provider || null)
    : (row.external_billing_provider || null);

  return {
    accountId: row.account_id,
    parentAccountId,
    email: row.email,
    phoneE164: row.phone_e164,
    plan,
    status: row.status,
    billingPeriod: period,
    externalBillingId,
    externalBillingProvider,
    action: externalBillingId ? 'append' : 'create',
    baseCharge,
    dataTotalMb: num(row.data_total_mb),
    planCapMb: num(row.plan_cap_mb),
    overageMb,
    overageGb: Math.ceil(overageMb / 1024),
    overageRate: OVERAGE_RATES[plan] || 0,
    overageCharge,
    totalCharge: round2(baseCharge + overageCharge),
    // The endpoint billed against lives on the usage row; the eSIM ICCID is on
    // the account.
    bicsEndpointId: row.endpoint_id || null,
    bicsIccid: row.bics_iccid || null,
  };
}

/**
 * Build the full monthly billing export.
 * @param {number|string} year
 * @param {number|string} month - 1-12
 * @returns {Promise<object>} { period, generatedAt, recordCount, totalRevenue,
 *   newAccounts, existingAccounts, records[] }
 */
async function generateMonthlyExport(year, month) {
  const { start, end, period } = monthRange(year, month);

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
       FROM usage_records ur
       ${JOIN_CLAUSE}
      WHERE ur.period_start >= $1 AND ur.period_start < $2
      ORDER BY a.email`,
    [start, end],
  );

  const records = result.rows.map((row) => buildRecord(row, period));
  const totalRevenue = round2(records.reduce((sum, r) => sum + r.totalCharge, 0));
  const newAccounts = records.filter((r) => r.action === 'create').length;
  const existingAccounts = records.filter((r) => r.action === 'append').length;

  return {
    period,
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    totalRevenue,
    newAccounts,
    existingAccounts,
    records,
  };
}

// CSV column order. `action` is first so the Gaiia importer can route each row
// (append vs create) without parsing the rest.
const CSV_COLUMNS = [
  ['action', (r) => r.action],
  ['external_billing_id', (r) => r.externalBillingId],
  ['account_id', (r) => r.accountId],
  ['parent_account_id', (r) => r.parentAccountId],
  ['email', (r) => r.email],
  ['phone', (r) => r.phoneE164],
  ['plan', (r) => r.plan],
  ['billing_period', (r) => r.billingPeriod],
  ['base_charge', (r) => r.baseCharge],
  ['data_total_mb', (r) => r.dataTotalMb],
  ['plan_cap_mb', (r) => r.planCapMb],
  ['overage_mb', (r) => r.overageMb],
  ['overage_gb', (r) => r.overageGb],
  ['overage_rate', (r) => r.overageRate],
  ['overage_charge', (r) => r.overageCharge],
  ['total_charge', (r) => r.totalCharge],
  ['bics_endpoint_id', (r) => r.bicsEndpointId],
  ['bics_iccid', (r) => r.bicsIccid],
];

/** RFC-4180 field escaping: quote fields containing comma, quote, or newline. */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Build the monthly export as a CSV string (header row + one row per record).
 * @param {number|string} year
 * @param {number|string} month
 * @returns {Promise<string>}
 */
async function exportToCsv(year, month) {
  const { records } = await generateMonthlyExport(year, month);
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const lines = records.map(
    (record) => CSV_COLUMNS.map(([, get]) => csvEscape(get(record))).join(','),
  );
  return [header, ...lines].join('\n');
}

/**
 * Billing detail for a single account in a given month (customer portal).
 * @returns {Promise<object|null>} the billing record, or null if no usage.
 */
async function getAccountBillingSummary(accountId, year, month) {
  const { start, end, period } = monthRange(year, month);

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
       FROM usage_records ur
       ${JOIN_CLAUSE}
      WHERE ur.account_id = $1
        AND ur.period_start >= $2 AND ur.period_start < $3
      LIMIT 1`,
    [accountId, start, end],
  );

  if (result.rows.length === 0) return null;
  return buildRecord(result.rows[0], period);
}

module.exports = {
  PLAN_PRICES,
  generateMonthlyExport,
  exportToCsv,
  getAccountBillingSummary,
};
