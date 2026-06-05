-- 003_dids.sql
-- DID (phone number) inventory. Every customer number lives in SignalWire;
-- this table is the middleware's record of inventory and assignment.
-- References accounts (003 depends on 001) and tcr_campaigns (depends on 002).

CREATE TABLE dids (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  e164                VARCHAR(20) UNIQUE NOT NULL,
  area_code           VARCHAR(3) NOT NULL,
  market              VARCHAR(100) NOT NULL,
  signalwire_sid      VARCHAR(100) NOT NULL,
  account_id          UUID REFERENCES accounts(id),
  campaign_id         UUID REFERENCES tcr_campaigns(id),
  status              VARCHAR(20) NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','assigned','porting_in','porting_out','reserved')),
  ported_in           BOOLEAN NOT NULL DEFAULT FALSE,
  ported_in_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dids_status ON dids (status);
CREATE INDEX idx_dids_market ON dids (market);
CREATE INDEX idx_dids_area_code ON dids (area_code);
CREATE INDEX idx_dids_account_id ON dids (account_id);
CREATE INDEX idx_dids_campaign_id ON dids (campaign_id);
CREATE UNIQUE INDEX idx_dids_signalwire_sid ON dids (signalwire_sid);

CREATE TRIGGER trg_dids_updated_at
  BEFORE UPDATE ON dids
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
