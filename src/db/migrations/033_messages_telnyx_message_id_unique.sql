-- 033_messages_telnyx_message_id_unique.sql
-- Make inbound-message dedup airtight: a UNIQUE index on telnyx_message_id so
-- Telnyx double-webhook delivery can never create duplicate rows, even under a
-- race (the app-level check in handleInboundMessage is now backed by the DB).
--
-- Partial (WHERE telnyx_message_id IS NOT NULL) so rows without a Telnyx id
-- (e.g. synthetic voicemail-delivery messages) are unaffected.

-- First remove any pre-existing duplicates, keeping one row per id, or the
-- CREATE UNIQUE INDEX would fail on existing data. (Classic ctid self-join:
-- keeps the row with the smallest ctid per telnyx_message_id.)
DELETE FROM messages a
  USING messages b
 WHERE a.telnyx_message_id IS NOT NULL
   AND a.telnyx_message_id = b.telnyx_message_id
   AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS messages_telnyx_message_id_unique
  ON messages (telnyx_message_id)
  WHERE telnyx_message_id IS NOT NULL;
