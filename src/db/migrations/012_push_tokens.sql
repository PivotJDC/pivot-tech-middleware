-- 012_push_tokens.sql
-- Acrobits Cloud Softphone push tokens. The app registers its push token via
-- the Acrobits messaging web service; we use these to wake the app (via the
-- Acrobits Push Notification Manager) when a new inbound message arrives.
-- One row per (account, device); re-registration upserts on that pair.

CREATE TABLE IF NOT EXISTS push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  device_token TEXT NOT NULL,
  selector TEXT,
  app_id TEXT NOT NULL,
  platform VARCHAR(10) NOT NULL,
  device_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_account ON push_tokens(account_id);
