-- Bot-to-bot messaging, teammate management by bots (docs/BOT_MESSAGING.md v2). Additive.
CREATE TABLE IF NOT EXISTS bot_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initiator_bot_id uuid REFERENCES bots(id) ON DELETE SET NULL,
  peer_bot_id      uuid REFERENCES bots(id) ON DELETE SET NULL,
  initiator_name text NOT NULL,
  peer_name      text NOT NULL,
  title text NOT NULL,
  root_thread_id uuid NOT NULL,
  parent_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  depth int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'sending',
  error_code text,
  message_count int NOT NULL DEFAULT 0,
  last_notice_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_threads_status_chk CHECK (status IN
    ('sending','waiting','replied','failed','timed_out','paused','closed'))
);
CREATE INDEX IF NOT EXISTS bot_threads_owner_idx ON bot_threads (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS bot_threads_pair_idx  ON bot_threads (initiator_bot_id, peer_bot_id, status);
CREATE INDEX IF NOT EXISTS bot_threads_root_idx  ON bot_threads (root_thread_id);

CREATE TABLE IF NOT EXISTS bot_thread_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES bot_threads(id) ON DELETE CASCADE,
  seq int NOT NULL,
  from_bot_id uuid REFERENCES bots(id) ON DELETE SET NULL,
  to_bot_id   uuid REFERENCES bots(id) ON DELETE SET NULL,
  kind text NOT NULL,
  content text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]',
  source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  delivered_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, seq),
  CONSTRAINT bot_thread_messages_kind_chk CHECK (kind IN ('request','reply','system'))
);

-- One row per management call, so a retry never creates a second bot or routine.
CREATE TABLE IF NOT EXISTS bot_manage_actions (
  idempotency_key text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid,
  task_id uuid,
  tool text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_manage_actions_owner_idx ON bot_manage_actions (owner_id, tool, created_at);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS origin_thread_id uuid REFERENCES bot_threads(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS origin_depth int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS tasks_origin_thread_idx ON tasks (origin_thread_id) WHERE origin_thread_id IS NOT NULL;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS peer_messaging boolean NOT NULL DEFAULT true;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS created_by_bot_id uuid REFERENCES bots(id) ON DELETE SET NULL;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS origin_depth int NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS created_by_bot_id uuid REFERENCES bots(id) ON DELETE SET NULL;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS origin_depth int NOT NULL DEFAULT 0;
ALTER TABLE user_quotas ADD COLUMN IF NOT EXISTS peer_msgs_per_day int NOT NULL DEFAULT 200;
ALTER TABLE user_quotas ADD COLUMN IF NOT EXISTS peer_chain_budget_usd numeric(8,4) NOT NULL DEFAULT 0.10;
ALTER TABLE user_quotas ADD COLUMN IF NOT EXISTS bot_creates_per_day int NOT NULL DEFAULT 3;
ALTER TABLE outbound_actions DROP CONSTRAINT IF EXISTS outbound_actions_kind_chk;
ALTER TABLE outbound_actions ADD CONSTRAINT outbound_actions_kind_chk
  CHECK (kind IN ('send','post','purchase','plugin_write','delete','bot_message','bot_manage'));
