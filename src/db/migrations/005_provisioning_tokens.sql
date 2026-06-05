-- 005_provisioning_tokens.sql
-- Single-use tokens that gate the Acrobits provisioning XML endpoint.
-- Only the SHA-256 hash of the token is stored; the raw token lives only in
-- the QR code / deep link handed to the customer. Expires 72h after issue.

CREATE TABLE provisioning_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id),
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_provisioning_tokens_account_id ON provisioning_tokens (account_id);
CREATE INDEX idx_provisioning_tokens_expires_at ON provisioning_tokens (expires_at);
