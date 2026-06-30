-- 019_message_records.sql
-- Message detail records (CDR-style log for SMS/MMS), populated from Telnyx
-- messaging webhooks and keyed to an account by from/to vs accounts.phone_e164.
-- Separate from the `messages` table (which holds bodies/media for the dialer);
-- this is the lightweight history/audit log surfaced in account history views.

CREATE TABLE IF NOT EXISTS message_records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id),
  message_id    VARCHAR(255) NOT NULL,
  direction     VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number   VARCHAR(20) NOT NULL,
  to_number     VARCHAR(20) NOT NULL,
  status        VARCHAR(30) NOT NULL,
  message_type  VARCHAR(10) DEFAULT 'sms' CHECK (message_type IN ('sms', 'mms')),
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_records_account ON message_records(account_id);
