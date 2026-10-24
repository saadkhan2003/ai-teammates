CREATE TABLE skill_library (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tenant_id uuid NULL, bot_id uuid NULL REFERENCES bots(id) ON DELETE CASCADE,
 name text NOT NULL, title text NOT NULL, when_to_use text NOT NULL, body text NOT NULL,
 kind text NOT NULL DEFAULT 'guide' CHECK (kind IN ('guide','replay')),
 source text NOT NULL CHECK (source IN ('builtin','user','bot')), version integer NOT NULL DEFAULT 1,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz NULL,
 CHECK (length(body) <= 32768)
);
CREATE INDEX skill_library_visible ON skill_library(owner_id, bot_id, name) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX skill_library_scope_name ON skill_library(owner_id, coalesce(bot_id,'00000000-0000-0000-0000-000000000000'::uuid), name) WHERE archived_at IS NULL;
CREATE TABLE skill_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), skill_id uuid NOT NULL REFERENCES skill_library(id) ON DELETE CASCADE,
 version integer NOT NULL, body text NOT NULL, author text NOT NULL, reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(skill_id,version)
);
