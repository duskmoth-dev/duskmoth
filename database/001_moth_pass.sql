-- Apply manually to your own database before enabling PostgreSQL Moth Pass storage.
-- Never replace an existing issuer, replay history, or production data.
BEGIN;
CREATE TABLE IF NOT EXISTS moth_pass_issuers (
  id text PRIMARY KEY,
  kid text NOT NULL UNIQUE,
  encrypted_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS moth_pass_burns (
  burn text PRIMARY KEY,
  batch text NOT NULL CHECK (batch ~ '^[a-f0-9]{64}$'),
  count integer NOT NULL CHECK (count BETWEEN 1 AND 50),
  kid text NOT NULL REFERENCES moth_pass_issuers(kid)
);
CREATE TABLE IF NOT EXISTS moth_pass_spent (
  hash text PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'),
  grant text NOT NULL CHECK (grant ~ '^[a-f0-9]{64}$'),
  request_id text CHECK (request_id IS NULL OR request_id ~ '^[a-f0-9]{32}$'),
  feature text,
  binding text,
  encrypted_result text,
  result_expires_at timestamptz
);
-- Additive compatibility for databases created before premium result recovery.
ALTER TABLE moth_pass_spent ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE moth_pass_spent ADD COLUMN IF NOT EXISTS feature text;
ALTER TABLE moth_pass_spent ADD COLUMN IF NOT EXISTS binding text;
ALTER TABLE moth_pass_spent ADD COLUMN IF NOT EXISTS encrypted_result text;
ALTER TABLE moth_pass_spent ADD COLUMN IF NOT EXISTS result_expires_at timestamptz;
COMMIT;
