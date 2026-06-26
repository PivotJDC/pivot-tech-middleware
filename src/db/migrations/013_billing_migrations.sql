-- 013_billing_migrations.sql
-- Billing-provider routing between Telgoo5 (standalone mobile) and Gaiia
-- (broadband-bundled mobile). The account's current provider lives in
-- accounts.external_billing_provider; broadband linkage + promo are tracked
-- on the account, and every provider switch is recorded in billing_migrations.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS broadband_account_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS broadband_provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS billing_migration_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS promo_code VARCHAR(100);

CREATE TABLE IF NOT EXISTS billing_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  from_provider VARCHAR(50) NOT NULL,
  to_provider VARCHAR(50) NOT NULL,
  broadband_provider VARCHAR(50),
  broadband_account_id VARCHAR(100),
  promo_code VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','scheduled','completed','failed','reversed')),
  scheduled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_migrations_account ON billing_migrations(account_id);
CREATE INDEX IF NOT EXISTS idx_billing_migrations_broadband
  ON billing_migrations(broadband_provider, broadband_account_id);
