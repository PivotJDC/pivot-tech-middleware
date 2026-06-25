-- 011_messages.sql
-- SMS/MMS message log. Telnyx can't deliver messaging over SIP/SIMPLE to the
-- Acrobits dialer, so every message flows through this middleware via the Telnyx
-- REST Messaging API. One row per message (inbound or outbound); delivery status
-- is updated from Telnyx messaging webhooks.

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number VARCHAR(20) NOT NULL,
  to_number VARCHAR(20) NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  media_urls TEXT[] NOT NULL DEFAULT '{}',
  telnyx_message_id VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_account ON messages(account_id, created_at DESC);
CREATE INDEX idx_messages_telnyx_id ON messages(telnyx_message_id);
