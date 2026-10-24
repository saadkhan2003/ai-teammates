-- One unified usage meter: AI, computer and storage convert to credits at real cost.
CREATE TABLE IF NOT EXISTS billing_plans (
    id text PRIMARY KEY,
    name text NOT NULL,
    price_usd numeric(10,2) NOT NULL DEFAULT 0,
    weekly_credits bigint NOT NULL CHECK (weekly_credits >= 0),
    on_demand_cap_usd numeric(10,2) NOT NULL DEFAULT 0 CHECK (on_demand_cap_usd >= 0),
    job_default_minutes integer NOT NULL DEFAULT 60 CHECK (job_default_minutes BETWEEN 1 AND 1440),
    job_max_minutes integer NOT NULL DEFAULT 240 CHECK (job_max_minutes BETWEEN 1 AND 1440),
    max_running_jobs integer NOT NULL DEFAULT 3 CHECK (max_running_jobs BETWEEN 0 AND 20),
    upgrade_to text,
    sort integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
);
-- Default derived from the $30 cost model (estimates): 1 credit = $0.001 of real cost.
INSERT INTO billing_plans (id, name, price_usd, weekly_credits, on_demand_cap_usd, job_default_minutes, job_max_minutes, max_running_jobs, upgrade_to, sort)
VALUES ('standard', 'Standard', 30, 4500, 100, 60, 240, 3, 'pro', 10),
       ('pro', 'Pro', 100, 16000, 300, 120, 720, 6, NULL, 20)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS credit_rates (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    usd_per_credit numeric(12,6) NOT NULL DEFAULT 0.001 CHECK (usd_per_credit > 0),
    computer_credits_per_minute numeric(10,4) NOT NULL DEFAULT 0.1 CHECK (computer_credits_per_minute >= 0),
    storage_free_gb numeric(10,2) NOT NULL DEFAULT 5 CHECK (storage_free_gb >= 0),
    storage_credits_per_gb_week numeric(10,2) NOT NULL DEFAULT 50 CHECK (storage_credits_per_gb_week >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
);
INSERT INTO credit_rates (id) VALUES (true) ON CONFLICT DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_id text NOT NULL DEFAULT 'standard' REFERENCES billing_plans(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS on_demand_limit_usd numeric(10,2) CHECK (on_demand_limit_usd IS NULL OR on_demand_limit_usd > 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_anchor timestamptz;

-- One row per awake computer-minute (idempotent by minute). background = jobs were running.
CREATE TABLE IF NOT EXISTS computer_usage_minutes (
    computer_id uuid NOT NULL,
    minute timestamptz NOT NULL,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    background boolean NOT NULL DEFAULT false,
    PRIMARY KEY (computer_id, minute)
);
CREATE INDEX IF NOT EXISTS computer_usage_minutes_owner ON computer_usage_minutes (owner_id, minute);

-- Daily storage sample per owner (bytes kept: saved files plus measured computer disk).
CREATE TABLE IF NOT EXISTS storage_usage_days (
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day date NOT NULL,
    bytes bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, day)
);

-- Per-window snapshot; overage beyond the allowance is on-demand usage recorded for billing.
CREATE TABLE IF NOT EXISTS credit_windows (
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    window_start timestamptz NOT NULL,
    allowance bigint NOT NULL,
    used_credits numeric(14,3) NOT NULL DEFAULT 0,
    overage_credits numeric(14,3) NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, window_start)
);
