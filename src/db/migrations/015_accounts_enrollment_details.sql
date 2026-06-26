-- 015_accounts_enrollment_details.sql
-- Subscriber enrollment details captured at signup and required by Telgoo5
-- (name + service/billing addresses). Addresses are JSONB
-- ({ line1, line2, city, state, zip }). All nullable / backward compatible.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(50),
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(50),
  ADD COLUMN IF NOT EXISTS service_address JSONB,
  ADD COLUMN IF NOT EXISTS billing_address JSONB;
