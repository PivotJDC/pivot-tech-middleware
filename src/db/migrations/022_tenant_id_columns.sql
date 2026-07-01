-- 022_tenant_id_columns.sql
-- Seed the default MobilityNet tenant, add tenant_id to every tenant-scoped
-- table, backfill existing rows to MobilityNet, enforce NOT NULL, and index.
-- NB: existing queries are NOT changed to filter by tenant_id yet — that is the
-- next phase. This migration only establishes the columns + data.

-- Seed the default MobilityNet tenant first.
INSERT INTO tenants (id, slug, name, domain, status)
VALUES (
  '00000000-0000-4000-a000-000000000001',
  'mobilitynet',
  'MobilityNet',
  'mymobilitynet.io',
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- Add tenant_id columns (nullable first for backfill).
ALTER TABLE accounts         ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE dids             ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE admin_users      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE call_records     ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE message_records  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE usage_records    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

-- Backfill all existing data to the MobilityNet tenant.
UPDATE accounts        SET tenant_id = '00000000-0000-4000-a000-000000000001' WHERE tenant_id IS NULL;
UPDATE dids            SET tenant_id = '00000000-0000-4000-a000-000000000001' WHERE tenant_id IS NULL;
UPDATE admin_users     SET tenant_id = '00000000-0000-4000-a000-000000000001' WHERE tenant_id IS NULL;
UPDATE call_records    SET tenant_id = '00000000-0000-4000-a000-000000000001' WHERE tenant_id IS NULL;
UPDATE message_records SET tenant_id = '00000000-0000-4000-a000-000000000001' WHERE tenant_id IS NULL;
UPDATE usage_records   SET tenant_id = '00000000-0000-4000-a000-000000000001' WHERE tenant_id IS NULL;

-- Make NOT NULL after backfill.
ALTER TABLE accounts         ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dids             ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE admin_users      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE call_records     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE message_records  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE usage_records    ALTER COLUMN tenant_id SET NOT NULL;

-- Indexes for tenant-scoped queries.
CREATE INDEX IF NOT EXISTS idx_accounts_tenant        ON accounts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dids_tenant            ON dids(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_tenant     ON admin_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_records_tenant    ON call_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_message_records_tenant ON message_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_tenant   ON usage_records(tenant_id);
