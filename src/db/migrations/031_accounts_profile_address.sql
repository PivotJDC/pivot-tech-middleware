-- 031_accounts_profile_address.sql
-- Flat subscriber-profile address fields on accounts, edited from the admin
-- account detail page (PATCH /admin/accounts/:id/profile). These sit alongside
-- the existing service_address/billing_address JSONB (captured at signup) and
-- give CSRs simple, individually-editable columns for name/address/contact.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(255);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS state VARCHAR(2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS zip VARCHAR(10);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS phone_alt VARCHAR(20);
