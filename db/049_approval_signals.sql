-- Owner-authenticated feedback only. Learned content stays in the existing memories store.
CREATE TABLE approval_signals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
    message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('positive','negative','correction')),
    signal text NOT NULL CHECK (signal IN ('reaction','reply','quote','pick','approval','steer','redo')),
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key text NOT NULL,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    learned_at timestamptz,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (bot_id, dedupe_key)
);
CREATE INDEX approval_signals_pending ON approval_signals(bot_id,created_at) WHERE consumed_at IS NULL;
CREATE INDEX approval_signals_learning ON approval_signals(created_at) WHERE learned_at IS NULL;
ALTER TABLE memories
    ADD COLUMN learned_kind text CHECK (learned_kind IN ('preference','approved_decision','quality_bar','avoid')),
    ADD COLUMN learned_topic text,
    ADD COLUMN signal_ids uuid[] NOT NULL DEFAULT '{}',
    ADD COLUMN learned_source jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX memories_learned ON memories(bot_id,owner_id,updated_at DESC) WHERE learned_kind IS NOT NULL;
