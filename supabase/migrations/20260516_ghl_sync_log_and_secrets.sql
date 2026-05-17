-- ghl_sync_log: every inbound/outbound GHL event recorded for debugging + audit
CREATE TABLE IF NOT EXISTS ghl_sync_log (
  id bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT NOW(),
  direction    text NOT NULL CHECK (direction IN ('inbound','outbound')),
  event_type   text,
  location_id  text,
  branch_code  text,
  ghl_contact_id text,
  business_id  uuid,
  status       text NOT NULL,        -- ok | error | ignored | dup
  payload      jsonb,
  error        text,
  processed_ms int
);

CREATE INDEX IF NOT EXISTS idx_ghl_sync_log_recent  ON ghl_sync_log(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ghl_sync_log_status  ON ghl_sync_log(status) WHERE status != 'ok';
CREATE INDEX IF NOT EXISTS idx_ghl_sync_log_contact ON ghl_sync_log(ghl_contact_id) WHERE ghl_contact_id IS NOT NULL;

ALTER TABLE ghl_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ghl_sync_log_super_read ON ghl_sync_log;
CREATE POLICY ghl_sync_log_super_read ON ghl_sync_log FOR SELECT TO authenticated
  USING (auth_is_super());

-- Per-location webhook secret. We give each branch a unique shared secret
-- so each GHL sub-account can post to the same Edge Function and we can
-- verify the request is genuinely from THAT location.
CREATE TABLE IF NOT EXISTS ghl_webhook_secrets (
  location_id text PRIMARY KEY,
  branch_code text NOT NULL,
  secret      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  webhook_id  text,                       -- GHL-side subscription id once registered
  webhook_registered_at timestamptz
);

ALTER TABLE ghl_webhook_secrets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ghl_secrets_super ON ghl_webhook_secrets;
CREATE POLICY ghl_secrets_super ON ghl_webhook_secrets FOR ALL TO authenticated
  USING (auth_is_super()) WITH CHECK (auth_is_super());

INSERT INTO ghl_webhook_secrets (location_id, branch_code, secret) VALUES
  ('IN2aACrR1zKK0f47fwoF', 'SAC',    encode(gen_random_bytes(24), 'hex')),
  ('yBbusDRO9bunqAqrvShe', 'WDL',    encode(gen_random_bytes(24), 'hex')),
  ('3jsSjagsjEPw7fMXr7Ab', 'FRES',   encode(gen_random_bytes(24), 'hex')),
  ('444yycqwlI7HXuEt6CiU', 'RED',    encode(gen_random_bytes(24), 'hex')),
  ('UXmO2GvlzrZKNY5GvlLr', 'LAS',    encode(gen_random_bytes(24), 'hex')),
  ('8DsWShmAiV12FJgG7hDv', 'SPARKS', encode(gen_random_bytes(24), 'hex'))
ON CONFLICT (location_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
