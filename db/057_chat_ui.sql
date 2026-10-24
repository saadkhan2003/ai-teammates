-- Origin coding job cards supplement v0.5 task plans and computer jobs.
-- Replies use v0.5's reply_to_message_id; migrate any existing Origin columns.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='reply_to_id') THEN
    EXECUTE 'UPDATE messages SET reply_to_message_id=reply_to_id WHERE reply_to_message_id IS NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='reply_to') THEN
    EXECUTE 'UPDATE messages SET reply_to_message_id=reply_to WHERE reply_to_message_id IS NULL';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS coding_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    step text NOT NULL DEFAULT '',
    pr_number int,
    pr_url text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT coding_jobs_status_chk CHECK (status IN ('queued', 'running', 'tests', 'finished', 'merged', 'failed'))
);

CREATE INDEX IF NOT EXISTS coding_jobs_bot_idx ON coding_jobs (bot_id, updated_at DESC);
