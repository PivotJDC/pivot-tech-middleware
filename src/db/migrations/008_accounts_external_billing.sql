-- 008_accounts_external_billing.sql
-- Link an account to its record in a downstream billing system (initially
-- Gaiia). external_billing_id is the customer's id in that system:
--   NULL     -> new/mobile-only customer; the export emits action="create"
--   non-NULL -> existing customer; the export emits action="append" so the
--               mobile charges are added to their existing billing account.
-- external_billing_provider names the system (defaults to 'gaiia'). Both are
-- safe to re-run (IF NOT EXISTS).

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS external_billing_id VARCHAR(100);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS external_billing_provider VARCHAR(50) DEFAULT 'gaiia';
