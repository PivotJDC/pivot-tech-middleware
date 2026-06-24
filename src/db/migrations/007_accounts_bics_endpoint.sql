-- 007_accounts_bics_endpoint.sql
-- Link accounts to their BICS data endpoint / eSIM. bics_endpoint_id is the
-- handle the usage poller and lifecycle calls key off; bics_iccid records the
-- assigned eSIM. Both are nullable: an account may exist before the BICS
-- endpoint is provisioned. IF NOT EXISTS keeps this safe to re-run.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bics_endpoint_id VARCHAR(20);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bics_iccid VARCHAR(22);
