CREATE TABLE IF NOT EXISTS brief_lessons (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, lesson text NOT NULL,
 normalized_text text NOT NULL, source text NOT NULL CHECK(source IN ('steer','failed_run','rejected')),
 source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bot_id,normalized_text)
);
CREATE INDEX IF NOT EXISTS brief_lessons_bot ON brief_lessons(bot_id,created_at DESC);
-- Catch every failure/cancellation path (including sweeps), under the task's transaction.
CREATE OR REPLACE FUNCTION record_brief_failure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lesson_text text;
BEGIN
 IF NEW.status IN ('failed','cancelled') AND OLD.status IS DISTINCT FROM NEW.status
    AND EXISTS(SELECT 1 FROM task_briefs WHERE task_id=NEW.id) THEN
   -- Raw task errors already cross the existing API redactor. All lesson reads and
   -- auto-context injection also use the existing C# DLP/output/injection guards.
   lesson_text := 'Last brief for ' || left(NEW.title,120) || ' ' || NEW.status || ' because ' || left(coalesce(NEW.error,NEW.waiting_reason,'the user stopped the run'),400);
   INSERT INTO brief_lessons(bot_id,owner_id,lesson,normalized_text,source,source_task_id)
   SELECT NEW.bot_id,b.owner_id,lesson_text,lower(trim(regexp_replace(lesson_text,'\s+',' ','g'))),'failed_run',NEW.id FROM bots b WHERE b.id=NEW.bot_id
   ON CONFLICT(bot_id,normalized_text) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS task_brief_failure_lesson ON tasks;
CREATE TRIGGER task_brief_failure_lesson AFTER UPDATE OF status ON tasks FOR EACH ROW EXECUTE FUNCTION record_brief_failure();
