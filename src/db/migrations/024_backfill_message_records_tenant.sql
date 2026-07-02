-- 024_backfill_message_records_tenant.sql
-- Backfill message_records.tenant_id for any rows written before webhook CDRs
-- were tagged with the owning account's tenant (billing reconciliation showed
-- 0 SMS/MMS because these rows weren't tenant-scoped).
--
-- Derive the tenant from the account whose phone_e164 is one side of the
-- message (our DID is unique, so this resolves the owning account). Idempotent:
-- only touches rows still missing a tenant_id, and a no-op where 022 already
-- enforced NOT NULL.

UPDATE message_records mr
SET tenant_id = a.tenant_id
FROM accounts a
WHERE mr.tenant_id IS NULL
  AND (mr.from_number = a.phone_e164
       OR mr.to_number = a.phone_e164);
