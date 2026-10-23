CREATE TABLE IF NOT EXISTS devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL, os text NOT NULL, version text NOT NULL,
 token_hash text NOT NULL UNIQUE,
 execution text NOT NULL DEFAULT 'ask' CHECK (execution IN ('ask','always','off')),
 route_traffic boolean NOT NULL DEFAULT false,
 allow_files boolean NOT NULL DEFAULT false,
 allow_browser boolean NOT NULL DEFAULT false,
 last_seen timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_owner_idx ON devices(owner_id);
CREATE TABLE IF NOT EXISTS device_pairings (
 code_hash text PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
