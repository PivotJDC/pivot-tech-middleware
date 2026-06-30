-- 018_call_records.sql
-- Call detail records (CDRs). Populated from Telnyx voice status webhooks and
-- keyed to an account by matching from/to against accounts.phone_e164. call_sid
-- identifies a single call across its status updates (the service upserts on it).

CREATE TABLE IF NOT EXISTS call_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id),
  call_sid          VARCHAR(255) NOT NULL,
  direction         VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number       VARCHAR(20) NOT NULL,
  to_number         VARCHAR(20) NOT NULL,
  status            VARCHAR(30) NOT NULL,
  duration_seconds  INTEGER DEFAULT 0,
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_records_account ON call_records(account_id);
CREATE INDEX IF NOT EXISTS idx_call_records_call_sid ON call_records(call_sid);
