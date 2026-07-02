-- 023_push_tokens_reporter.sql
-- Reshape push_tokens for the Acrobits Push Token Reporter. The app reports two
-- separate tokens (calls / other) plus their app ids, scoped per (account,
-- selector) and tagged with the owning tenant.
--
-- Push tokens are ephemeral — the app re-reports them on launch via
-- pushTokenReporterUrl — so we drop and recreate rather than migrate the old
-- (device_token, app_id, UNIQUE(account_id, device_id)) shape from migration 012.

DROP TABLE IF EXISTS push_tokens;

CREATE TABLE push_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  selector            VARCHAR(255) NOT NULL,
  push_token_calls    TEXT,
  push_token_other    TEXT,
  push_app_id_calls   VARCHAR(255),
  push_app_id_other   VARCHAR(255),
  device_id           VARCHAR(255),
  platform            VARCHAR(20),
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE(account_id, selector)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_account ON push_tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_tenant ON push_tokens(tenant_id);
