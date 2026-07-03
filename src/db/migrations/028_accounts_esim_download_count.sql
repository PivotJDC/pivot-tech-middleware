-- 028_accounts_esim_download_count.sql
-- Track how many times an eSIM's install QR has been downloaded. A fresh eSIM
-- counts as 1; each admin "Show QR" reuse increments it. At 3 the endpoint is
-- force-regenerated (a new BICS eSIM), resetting the count.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS esim_download_count INTEGER DEFAULT 1;
