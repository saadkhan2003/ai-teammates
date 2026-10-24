CREATE TABLE IF NOT EXISTS one_time_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
    user_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    computer_id uuid,
    role text NOT NULL DEFAULT '',
    tab_id text NOT NULL DEFAULT '',
    epoch bigint NOT NULL DEFAULT 0,
    scope jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip_hash bytea,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS one_time_tickets_expiry_idx ON one_time_tickets(expires_at);

ALTER TABLE desktop_lease ADD COLUMN IF NOT EXISTS release_after timestamptz;
CREATE TABLE IF NOT EXISTS desktop_rw_connections (
    lease_computer_id uuid NOT NULL,
    display integer NOT NULL,
    epoch bigint NOT NULL,
    instance_id text NOT NULL,
    conn_id uuid NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (lease_computer_id, display, epoch, instance_id, conn_id)
);
CREATE INDEX IF NOT EXISTS desktop_rw_connections_heartbeat_idx ON desktop_rw_connections(heartbeat_at);

CREATE TABLE IF NOT EXISTS active_teach (
    bot_id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    session_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    stopping boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS active_teach_expiry_idx ON active_teach(expires_at);

CREATE TABLE IF NOT EXISTS egress_rate_windows (
    computer_id uuid PRIMARY KEY,
    window_started timestamptz NOT NULL,
    decision_count integer NOT NULL CHECK (decision_count >= 0)
);
CREATE TABLE IF NOT EXISTS login_rate_events (
    id bigserial PRIMARY KEY,
    ip_hash bytea NOT NULL,
    failed boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS login_rate_events_ip_time_idx ON login_rate_events(ip_hash, created_at);
CREATE TABLE IF NOT EXISTS api_rate_windows (
    scope_hash bytea PRIMARY KEY CHECK (octet_length(scope_hash)=32),
    window_started timestamptz NOT NULL,
    request_count integer NOT NULL CHECK (request_count >= 0)
);

CREATE TABLE IF NOT EXISTS login_broker_slots (
    id uuid PRIMARY KEY,
    nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
    ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 16 AND 8192),
    save_to_vault boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS login_broker_slots_expiry_idx ON login_broker_slots(created_at);
