CREATE TABLE IF NOT EXISTS escrow_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relay_key TEXT NOT NULL UNIQUE,
  owner_peer_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  encrypted_package JSONB NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS escrow_lease_history (
  lease_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id UUID NOT NULL,
  relay_key TEXT NOT NULL,
  requester_id TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  evidence JSONB,
  reasons JSONB,
  payload_digest TEXT NOT NULL,
  released_at TIMESTAMPTZ,
  release_reason TEXT
);

CREATE TABLE IF NOT EXISTS escrow_audit_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  escrow_id UUID,
  lease_id UUID,
  relay_key TEXT,
  actor TEXT,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_escrow_lease_history_escrow_id ON escrow_lease_history (escrow_id);
CREATE INDEX IF NOT EXISTS idx_escrow_lease_history_relay_key ON escrow_lease_history (relay_key);
CREATE INDEX IF NOT EXISTS idx_escrow_audit_log_created_at ON escrow_audit_log (created_at);
