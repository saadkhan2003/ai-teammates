CREATE TABLE IF NOT EXISTS uptime_checks (
    id bigserial PRIMARY KEY,
    service text NOT NULL,
    status text NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uptime_checks_service_time_idx ON uptime_checks (service, checked_at DESC);

CREATE TABLE IF NOT EXISTS uptime_daily (
    service text NOT NULL,
    day date NOT NULL,
    up_count int NOT NULL DEFAULT 0,
    degraded_count int NOT NULL DEFAULT 0,
    down_count int NOT NULL DEFAULT 0,
    PRIMARY KEY (service, day)
);

CREATE TABLE IF NOT EXISTS uptime_incidents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service text NOT NULL,
    title text NOT NULL,
    status text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS uptime_incidents_started_idx ON uptime_incidents (started_at DESC);

CREATE TABLE IF NOT EXISTS uptime_heartbeats (
    name text PRIMARY KEY,
    seen_at timestamptz NOT NULL
);
