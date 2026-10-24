-- Resource plan: per-plan storage quota, RAM and CPU; users' saved files on object storage; nightly cleanup.
ALTER TABLE billing_plans
    ADD COLUMN IF NOT EXISTS storage_quota_gb integer NOT NULL DEFAULT 50 CHECK (storage_quota_gb BETWEEN 1 AND 10000),
    ADD COLUMN IF NOT EXISTS storage_warn_pct integer NOT NULL DEFAULT 80 CHECK (storage_warn_pct BETWEEN 1 AND 100),
    ADD COLUMN IF NOT EXISTS ram_mb integer NOT NULL DEFAULT 8192 CHECK (ram_mb BETWEEN 512 AND 262144),
    ADD COLUMN IF NOT EXISTS cpu_min_cores numeric(5,2) NOT NULL DEFAULT 1 CHECK (cpu_min_cores > 0),
    ADD COLUMN IF NOT EXISTS cpu_max_cores numeric(5,2) NOT NULL DEFAULT 2 CHECK (cpu_max_cores > 0);
ALTER TABLE billing_plans DROP CONSTRAINT IF EXISTS billing_plans_cpu_range;
ALTER TABLE billing_plans ADD CONSTRAINT billing_plans_cpu_range CHECK (cpu_max_cores >= cpu_min_cores);
UPDATE billing_plans SET storage_quota_gb = 200, ram_mb = 16384, cpu_min_cores = 2, cpu_max_cores = 4 WHERE id = 'pro' AND storage_quota_gb = 50 AND ram_mb = 8192;

-- Durable copy of each bot's saved files. The computer's SSD working dir is a cache of this.
CREATE TABLE IF NOT EXISTS stored_files (
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    path text NOT NULL CHECK (length(path) BETWEEN 1 AND 1024 AND path NOT LIKE '/%' AND path !~ '(^|/)\.\.(/|$)'),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    mtime_ns bigint NOT NULL,
    sha256 text NOT NULL,
    object_key text NOT NULL,
    source_computer uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bot_id, path)
);
CREATE INDEX IF NOT EXISTS stored_files_owner ON stored_files (owner_id);

CREATE TABLE IF NOT EXISTS workspace_sync (
    computer_id uuid NOT NULL,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    token text NOT NULL,
    pulled_at timestamptz,
    pushed_at timestamptz,
    pulled_files integer NOT NULL DEFAULT 0,
    pushed_files integer NOT NULL DEFAULT 0,
    skipped_quota integer NOT NULL DEFAULT 0,
    last_error text,
    cleaned_at timestamptz,
    PRIMARY KEY (computer_id, bot_id)
);

-- Latest RAM/CPU reading per computer (usage page and admin).
CREATE TABLE IF NOT EXISTS computer_resources (
    computer_id uuid PRIMARY KEY,
    owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
    memory_bytes bigint NOT NULL DEFAULT 0,
    memory_limit_bytes bigint NOT NULL DEFAULT 0,
    memory_peak_bytes bigint NOT NULL DEFAULT 0,
    cpu_max_cores numeric(5,2),
    sampled_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS computer_resources_owner ON computer_resources (owner_id);

CREATE TABLE IF NOT EXISTS cleanup_runs (
    id bigserial PRIMARY KEY,
    trigger text NOT NULL CHECK (trigger IN ('nightly','admin','sleep')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    computers integer NOT NULL DEFAULT 0,
    removed_files integer NOT NULL DEFAULT 0,
    removed_bytes bigint NOT NULL DEFAULT 0,
    removed_backups integer NOT NULL DEFAULT 0,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
