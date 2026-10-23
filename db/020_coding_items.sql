CREATE TABLE IF NOT EXISTS coding_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title text NOT NULL,
    branch text NOT NULL DEFAULT '',
    repo_url text NOT NULL DEFAULT '',
    pr_number integer,
    pr_url text NOT NULL DEFAULT '',
    pr_state text NOT NULL DEFAULT '' CHECK (pr_state IN ('','open','merged','closed')),
    ci_state text NOT NULL DEFAULT 'unknown',
    changed_files integer NOT NULL DEFAULT 0,
    files jsonb NOT NULL DEFAULT '[]'::jsonb,
    diff text NOT NULL DEFAULT '',
    tests_ok boolean,
    tests_summary text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(task_id)
);
CREATE INDEX IF NOT EXISTS coding_items_bot_idx ON coding_items(bot_id, updated_at DESC);
