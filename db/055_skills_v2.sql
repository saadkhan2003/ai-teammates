ALTER TABLE skill_library ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skill_revisions ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skill_revisions ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE skill_revisions ADD COLUMN IF NOT EXISTS when_to_use text NOT NULL DEFAULT '';
DO $$
DECLARE constraint_name text;
BEGIN
    SELECT conname INTO constraint_name FROM pg_constraint
    WHERE conrelid='skill_library'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%source%bot_id%IS NOT NULL%';
    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE skill_library DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;
