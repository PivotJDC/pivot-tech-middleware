-- 006_usage_records.sql
-- Per-subscriber BICS data-usage snapshots. The usage poller UPSERTs one row
-- per (account, billing period); re-polling the same period overwrites the
-- metrics in place (unique index below). Feeds the customer usage bar, the
-- admin dashboard, and the Gaiia billing export.

CREATE TABLE IF NOT EXISTS usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  endpoint_id VARCHAR(20) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  data_uplink_mb NUMERIC(12,3) NOT NULL DEFAULT 0,
  data_downlink_mb NUMERIC(12,3) NOT NULL DEFAULT 0,
  data_total_mb NUMERIC(12,3) NOT NULL DEFAULT 0,
  data_cost NUMERIC(10,3) NOT NULL DEFAULT 0,
  sms_count INTEGER NOT NULL DEFAULT 0,
  plan_data_cap_mb NUMERIC(12,3) NOT NULL,
  overage_mb NUMERIC(12,3) NOT NULL DEFAULT 0,
  overage_charge NUMERIC(10,2) NOT NULL DEFAULT 0,
  polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_records_account ON usage_records(account_id);
CREATE INDEX idx_usage_records_period ON usage_records(period_start, period_end);
CREATE UNIQUE INDEX idx_usage_records_account_period
  ON usage_records(account_id, period_start, period_end);
