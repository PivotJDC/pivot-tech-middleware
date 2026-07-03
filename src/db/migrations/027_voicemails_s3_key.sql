-- 027_voicemails_s3_key.sql
-- Permanent recording storage: Telnyx recording URLs expire after ~10 minutes,
-- so we copy the audio to S3 and keep its object key here. Playback generates a
-- fresh signed URL from this key on demand. recording_url retains the Telnyx URL
-- as a best-effort fallback when the S3 copy is unavailable.

ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS recording_s3_key TEXT;
