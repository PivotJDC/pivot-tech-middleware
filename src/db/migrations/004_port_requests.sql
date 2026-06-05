-- 004_port_requests.sql
-- Number port-in requests (Phase 2). Tracks a customer's request to port an
-- existing number from a losing carrier into SignalWire.
-- pin_encrypted holds the AES-256-GCM ciphertext of the transfer PIN — never plaintext.

CREATE TABLE port_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id),
  number_e164         VARCHAR(20) NOT NULL,
  losing_carrier      VARCHAR(100) NOT NULL,
  account_number      VARCHAR(100) NOT NULL,
  pin_encrypted       VARCHAR(500) NOT NULL,
  billing_zip         VARCHAR(10) NOT NULL,
  signalwire_port_id  VARCHAR(100),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('submitted','pending','approved','completed','failed','cancelled')),
  failure_reason      TEXT,
  submitted_at        TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_port_requests_account_id ON port_requests (account_id);
CREATE INDEX idx_port_requests_status ON port_requests (status);
CREATE INDEX idx_port_requests_number_e164 ON port_requests (number_e164);
CREATE INDEX idx_port_requests_sw_port_id ON port_requests (signalwire_port_id);

CREATE TRIGGER trg_port_requests_updated_at
  BEFORE UPDATE ON port_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
