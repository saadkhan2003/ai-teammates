ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS ttft_ms int NULL;
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS total_ms int NULL;
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS cached_tokens int NULL;
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS cache_write_tokens int NULL;
CREATE TABLE IF NOT EXISTS perf_events (
    id bigserial PRIMARY KEY,
    source text NOT NULL CHECK (source IN ('client','server')),
    name text NOT NULL,
    value_ms double precision NOT NULL,
    owner_id uuid NULL,
    bot_id uuid NULL,
    route text NULL,
    attrs jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS perf_events_name_created_at ON perf_events(name, created_at);
CREATE INDEX IF NOT EXISTS perf_events_created_at ON perf_events(created_at);
