-- 009_accounts_bics_provisioned.sql
-- Tracks whether the account's BICS eSIM was successfully provisioned. The DID
-- (Telnyx) is purchased first and the account is always created; BICS eSIM
-- provisioning runs after and is best-effort. false = needs a retry (admin
-- PATCH /admin/accounts/:id { action: "retry_bics" }). Safe to re-run.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bics_provisioned BOOLEAN NOT NULL DEFAULT false;
