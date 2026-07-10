-- 036_messages_video_thumbnail_cache.sql
-- Cache the video thumbnail (base64 JPEG) on the message row so the Acrobits
-- fetch endpoint can serve the preview without an S3 getObjectBuffer call on
-- every poll. A slow or transient S3 read returned null, which made the
-- thumbnail flicker — appear on one poll, then disappear on the next. Once the
-- thumbnail is generated it is stored here and served from the row thereafter.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS video_thumbnail_base64 TEXT;
