-- 020_usage_notification_flags.sql
-- Per-period usage-notification flags. Recorded on usage_records (one row per
-- account + billing period) so they reset automatically at the start of each
-- period: a new period is a new row with the defaults below. The poller sets a
-- flag when the subscriber crosses 80% / 90% / 100% of the plan's data cap.

ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS notified_80  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notified_90  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notified_100 BOOLEAN NOT NULL DEFAULT false;
