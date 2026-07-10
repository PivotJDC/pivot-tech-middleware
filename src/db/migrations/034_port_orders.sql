-- 034_port_orders.sql
-- FastPort number porting (Phase 1). A richer, Telnyx-porting-order-native model
-- than the legacy port_requests table: it tracks the full Telnyx porting order
-- lifecycle (draft -> submitted -> ported), FastPort eligibility, the FOC date,
-- and the temp DID we assign for instant service while the port completes.
--
-- Legacy note: port_requests remains for the older FastPort-less flow + the admin
-- retry endpoint. New porting goes through port_orders (portService). Both carry
-- tenancy through their owning account_id (CLAUDE.md multi-tenant model).
--
-- Secrets (CLAUDE.md rule #2/#3): account_number and PIN are AES-256-GCM at rest
-- (account_number_encrypted / pin_encrypted), decrypted only in-memory in
-- portService immediately before Telnyx submission — never logged or returned.

CREATE TABLE IF NOT EXISTS port_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  telnyx_port_order_id VARCHAR,
  phone_number VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'draft',
  fast_port_eligible BOOLEAN DEFAULT false,
  carrier_name VARCHAR,
  foc_date TIMESTAMPTZ,
  temp_did VARCHAR,
  account_number_encrypted TEXT,
  pin_encrypted TEXT,
  auth_person_name VARCHAR,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Webhook lookups key on the Telnyx porting-order id; status listing and the
-- per-subscriber "my current port" query key on account_id.
CREATE INDEX IF NOT EXISTS port_orders_telnyx_id_idx
  ON port_orders (telnyx_port_order_id)
  WHERE telnyx_port_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS port_orders_account_id_idx ON port_orders (account_id);
CREATE INDEX IF NOT EXISTS port_orders_status_idx ON port_orders (status);
