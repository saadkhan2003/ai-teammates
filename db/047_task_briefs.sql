-- 043–046 are reserved for the parallel program; migrations are explicitly listed.
CREATE TABLE IF NOT EXISTS task_briefs (
 task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
 parent_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
 brief jsonb NOT NULL, markdown text NOT NULL, quality jsonb NOT NULL,
 thought_ms int NOT NULL DEFAULT 0 CHECK(thought_ms >= 0),
 version int NOT NULL DEFAULT 1 CHECK(version > 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_briefs_parent ON task_briefs(parent_task_id, conversation_id);
CREATE TABLE IF NOT EXISTS task_brief_steering (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES task_briefs(task_id) ON DELETE CASCADE,
 text text NOT NULL CHECK(length(text) BETWEEN 1 AND 4000), actor uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_brief_steering_task ON task_brief_steering(task_id, created_at, id);
CREATE TABLE IF NOT EXISTS brief_rewrite_attempts (
 parent_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, title text NOT NULL,
 attempts int NOT NULL DEFAULT 1, PRIMARY KEY(parent_task_id,title)
);
