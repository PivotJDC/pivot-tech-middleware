-- 001_accounts.sql
-- Core customer account record. One row per Pivot-Tech subscriber.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Shared trigger to keep updated_at current on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               VARCHAR(255) UNIQUE NOT NULL,
  phone_e164          VARCHAR(20),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','active','suspended','cancelled')),
  market              VARCHAR(100) NOT NULL,
  plan                VARCHAR(50) NOT NULL DEFAULT 'unlimited_25',
  sip_endpoint_id     VARCHAR(100),
  sip_username        VARCHAR(100),
  sip_password_hash   VARCHAR(255),
  esim_iccid          VARCHAR(50),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ
);

CREATE INDEX idx_accounts_status ON accounts (status);
CREATE INDEX idx_accounts_market ON accounts (market);
CREATE INDEX idx_accounts_phone_e164 ON accounts (phone_e164);

CREATE TRIGGER trg_accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
