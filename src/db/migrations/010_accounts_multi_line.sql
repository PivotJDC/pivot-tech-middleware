-- 010_accounts_multi_line.sql
-- Multi-line (family plan) support. A primary account has parent_account_id
-- NULL; a child line points at its primary via parent_account_id. Each line
-- still gets its own DID / eSIM / provisioning — only billing is consolidated
-- under the primary.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS parent_account_id UUID REFERENCES accounts(id);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS line_label VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(parent_account_id);

-- Child lines share the primary's email, so email can no longer be globally
-- unique. Drop the original table-level UNIQUE (created in 001 as the implicit
-- accounts_email_key) and replace it with a partial unique index that keeps
-- PRIMARY accounts unique by email while letting child lines reuse it.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_accounts_email_primary
  ON accounts(email) WHERE parent_account_id IS NULL;
