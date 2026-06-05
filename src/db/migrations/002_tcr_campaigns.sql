-- 002_tcr_campaigns.sql
-- 10DLC / TCR messaging campaigns, one (or more) per market.
-- DIDs are assigned to a campaign for compliant A2P/P2P messaging.
-- Must run before 003_dids.sql, which references this table.

CREATE TABLE tcr_campaigns (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market                    VARCHAR(100) NOT NULL,
  campaign_name             VARCHAR(255) NOT NULL,
  signalwire_campaign_id    VARCHAR(100) NOT NULL,
  use_case                  VARCHAR(100) NOT NULL DEFAULT 'MIXED',
  status                    VARCHAR(20) NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected','suspended')),
  approved_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tcr_campaigns_market ON tcr_campaigns (market);
CREATE INDEX idx_tcr_campaigns_status ON tcr_campaigns (status);
CREATE UNIQUE INDEX idx_tcr_campaigns_sw_id ON tcr_campaigns (signalwire_campaign_id);
