-- 026_voicemails.sql
-- Voicemail inbox. Populated from the TeXML voicemail flow (unanswered/busy/
-- declined inbound calls): the recording callback inserts a row, and a later
-- transcription callback fills in the text. account_id/tenant_id are resolved
-- from the called subscriber number in the webhook (no auth context there).

CREATE TABLE IF NOT EXISTS voicemails (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  caller_number     VARCHAR(20) NOT NULL,
  caller_name       VARCHAR(100),
  duration_seconds  INTEGER DEFAULT 0,
  recording_url     TEXT,
  recording_sid     VARCHAR(100),
  transcription     TEXT,
  is_read           BOOLEAN DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voicemails_account ON voicemails(account_id);
CREATE INDEX IF NOT EXISTS idx_voicemails_tenant ON voicemails(tenant_id);

-- Per-subscriber voicemail settings.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS voicemail_enabled BOOLEAN DEFAULT true;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS voicemail_greeting_url TEXT;
