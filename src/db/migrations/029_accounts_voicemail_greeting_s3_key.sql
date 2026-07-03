-- 029_accounts_voicemail_greeting_s3_key.sql
-- Store the S3 object key for a recorded voicemail greeting. Telnyx recording
-- URLs expire (~10 min), so the greeting is archived to S3 and a fresh signed
-- URL is generated on demand for playback. voicemail_greeting_url remains as a
-- best-effort fallback (the raw Telnyx URL) when S3 archival is unavailable.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS voicemail_greeting_s3_key TEXT;
