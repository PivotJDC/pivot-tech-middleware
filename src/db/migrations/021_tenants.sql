-- 021_tenants.sql
-- MVNE multi-tenant foundation: one row per reseller/brand ("tenant"). Existing
-- tables gain a tenant_id in 022. Config blobs (brand_config, plans,
-- billing_config) are JSONB; bics_sim_range is a text[] of ICCID ranges.

CREATE TABLE IF NOT EXISTS tenants (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                        VARCHAR(50) UNIQUE NOT NULL,
  name                        VARCHAR(255) NOT NULL,
  domain                      VARCHAR(255),
  acrobits_cloud_id           VARCHAR(50),
  brand_config                JSONB DEFAULT '{}',
  plans                       JSONB DEFAULT '[]',
  bics_sim_range              TEXT[] DEFAULT '{}',
  telnyx_credential_conn_id   VARCHAR(50),
  roaming_profile_id          VARCHAR(20),
  billing_config              JSONB DEFAULT '{}',
  status                      VARCHAR(20) DEFAULT 'onboarding'
                                CHECK (status IN ('onboarding', 'active', 'suspended', 'cancelled')),
  created_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                  TIMESTAMPTZ DEFAULT now()
);
