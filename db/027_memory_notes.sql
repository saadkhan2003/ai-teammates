ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS subject_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'profile' CHECK (kind IN ('profile','journal','rule','fact','summary')),
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'bot' CHECK (visibility IN ('bot','owner')),
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','superseded','deleted')),
  ADD COLUMN IF NOT EXISTS author text NOT NULL DEFAULT 'agent' CHECK (author IN ('user','agent','peer','routine','import')),
  ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES memories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS effective_at date,
  ADD COLUMN IF NOT EXISTS last_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS use_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS embedding_v2 vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_model text;

UPDATE memories m SET owner_id=b.owner_id FROM bots b WHERE m.bot_id=b.id AND m.owner_id IS NULL;
UPDATE memories SET author=CASE WHEN source='user' THEN 'user' ELSE 'agent' END;
UPDATE memories SET content_hash=encode(digest(trim(both ' .!?;:' from lower(regexp_replace(regexp_replace(trim(content), '^As of [0-9]{4}-[0-9]{2}-[0-9]{2},?\s*', '', 'i'), '[[:space:]]+', ' ', 'g'))), 'sha256'), 'hex') WHERE content_hash IS NULL;
WITH duplicates AS (
  SELECT id, row_number() OVER (PARTITION BY bot_id, kind, content_hash ORDER BY created_at, id) AS n
  FROM memories WHERE content_hash IS NOT NULL AND status IN ('active','pending')
)
UPDATE memories m SET status='superseded' FROM duplicates d WHERE m.id=d.id AND d.n>1;
UPDATE memories m SET source_message_id=substring(m.provenance FROM '^message:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')::uuid
WHERE m.provenance ~ '^message:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND EXISTS (SELECT 1 FROM messages x WHERE x.id=substring(m.provenance FROM '^message:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')::uuid);
UPDATE memories SET last_confirmed_at=updated_at, effective_at=created_at::date;

CREATE UNIQUE INDEX IF NOT EXISTS memories_dedupe ON memories (bot_id, kind, content_hash)
  WHERE status IN ('active','pending') AND content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_owner_shared ON memories (owner_id) WHERE visibility='owner' AND status='active';
CREATE INDEX IF NOT EXISTS memories_bot_status ON memories (bot_id, status, kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS bot_memory_settings (
  bot_id uuid PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','ask','off')),
  share_owner boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memory_events (
  id bigserial PRIMARY KEY, memory_id uuid NOT NULL, bot_id uuid, owner_id uuid,
  at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL, action text NOT NULL, task_id uuid,
  before_hash text, after_hash text, version int, detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS memory_events_memory ON memory_events (memory_id, at);
