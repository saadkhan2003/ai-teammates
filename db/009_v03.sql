-- v0.3: outbound actions, routine watches, plugin health. No process is started here.

CREATE TABLE IF NOT EXISTS outbound_actions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key text NOT NULL UNIQUE,
    owner_user_id uuid,
    bot_id uuid,
    task_id uuid,
    kind text NOT NULL,
    tool text NOT NULL,
    status text NOT NULL,
    request jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    CONSTRAINT outbound_actions_kind_chk CHECK (kind IN ('send','post','purchase','plugin_write')),
    CONSTRAINT outbound_actions_status_chk CHECK (status IN ('pending','completed','failed'))
);

CREATE INDEX IF NOT EXISTS outbound_actions_created_idx ON outbound_actions (created_at DESC);

ALTER TABLE routines ADD COLUMN IF NOT EXISTS watch_kind text NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN IF NOT EXISTS watch_ref text NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN IF NOT EXISTS watch_fingerprint text NOT NULL DEFAULT '';

ALTER TABLE plugin_catalog ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE plugin_catalog ADD COLUMN IF NOT EXISTS health_detail text NOT NULL DEFAULT '';
ALTER TABLE plugin_catalog ADD COLUMN IF NOT EXISTS health_checked_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_catalog_health_chk') THEN
        ALTER TABLE plugin_catalog
            ADD CONSTRAINT plugin_catalog_health_chk CHECK (health_status IN ('unknown','healthy','unhealthy'));
    END IF;
END $$;

ALTER TABLE plugin_jobs DROP CONSTRAINT IF EXISTS plugin_jobs_kind_chk;
ALTER TABLE plugin_jobs ADD CONSTRAINT plugin_jobs_kind_chk CHECK (kind IN ('import','check','health'));
