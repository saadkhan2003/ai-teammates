-- Message reactions. Applied once, recorded as schema_migrations id 002.
DO $$ BEGIN
    CREATE TYPE reaction_actor AS ENUM ('user', 'bot');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS message_reactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    actor_type reaction_actor NOT NULL,
    actor_id uuid NOT NULL,
    emoji text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (message_id, actor_type, actor_id)
);

CREATE INDEX IF NOT EXISTS message_reactions_message_idx ON message_reactions (message_id);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS event_seq bigint NOT NULL DEFAULT 0;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS bot_feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    emoji text NOT NULL,
    action text NOT NULL CHECK (action IN ('reacted', 'removed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS bot_feedback_pending_idx ON bot_feedback (bot_id, created_at) WHERE consumed_at IS NULL;
