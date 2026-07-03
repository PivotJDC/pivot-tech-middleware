-- 025_accounts_esim_activation_code.sql
-- Persist the BICS eSIM activation code (LPA string) on the account so the
-- admin dashboard can re-render the install QR without another BICS round-trip.
-- The legacy esim_iccid column (migration 001) is also populated going forward
-- alongside bics_iccid, so the ICCID is no longer left NULL.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS esim_activation_code TEXT;
