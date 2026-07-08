-- 032_accounts_port_out_pin.sql
-- Port-out PIN: the 6-digit code a subscriber gives their new carrier to
-- authorize transferring their number away. Generated at signup and resettable
-- from the customer portal. Stored in plaintext (it's shared with the customer
-- and, for CSR support, admins) — but never logged (CLAUDE.md security rule #1).

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS port_out_pin VARCHAR(6);

-- Backfill existing accounts with a random 6-digit PIN.
UPDATE accounts
   SET port_out_pin = LPAD((FLOOR(random() * 900000) + 100000)::int::text, 6, '0')
 WHERE port_out_pin IS NULL;
