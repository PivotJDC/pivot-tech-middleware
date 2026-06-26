-- 014_accounts_telgoo5.sql
-- Link an account to its Telgoo5 (vCare) BSS customer + enrollment so the
-- standalone-mobile billing/enrollment sync can be reconciled and looked up.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS telgoo5_customer_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS telgoo5_enrollment_id VARCHAR(100);
