-- 035_messages_group.sql
-- Group SMS/MMS support. Telnyx Group MMS (POST /v2/messages/group_mms) lets a
-- subscriber message several peers in one thread. We tag every message that
-- belongs to a group so the Acrobits fetch endpoint can thread them together and
-- list the participants.
--
--   group_id — Telnyx's group identifier (group_message_id, falling back to the
--              message id). Shared by every message in the same group thread;
--              NULL for ordinary 1:1 SMS/MMS.
--   cc       — the other participants' E.164 numbers. Outbound: the recipient
--              list. Inbound: Telnyx's `cc` array (everyone but the sender).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_id VARCHAR(100);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cc TEXT[] NOT NULL DEFAULT '{}';

-- Threading reads all messages sharing a group_id; index the non-null ids.
CREATE INDEX IF NOT EXISTS idx_messages_group
  ON messages (group_id)
  WHERE group_id IS NOT NULL;
