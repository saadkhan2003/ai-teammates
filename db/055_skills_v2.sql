ALTER TABLE skill_library ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skill_revisions ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skill_revisions ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE skill_revisions ADD COLUMN IF NOT EXISTS when_to_use text NOT NULL DEFAULT '';
