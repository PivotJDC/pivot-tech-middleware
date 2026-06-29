-- 016_accounts_e911.sql
-- E911 emergency-calling provisioning per account: the Telnyx address book id
-- the number is registered to, and whether emergency calling is enabled.
-- Nullable / default false (best-effort provisioning during signup).

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS e911_address_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS e911_enabled BOOLEAN DEFAULT false;
