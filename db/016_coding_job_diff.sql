-- Diff stats for the finished-job card. The id is 016 so a later branch can renumber it.
ALTER TABLE coding_jobs ADD COLUMN IF NOT EXISTS branch text NOT NULL DEFAULT '';
ALTER TABLE coding_jobs ADD COLUMN IF NOT EXISTS files_changed int NOT NULL DEFAULT 0;
ALTER TABLE coding_jobs ADD COLUMN IF NOT EXISTS additions int NOT NULL DEFAULT 0;
ALTER TABLE coding_jobs ADD COLUMN IF NOT EXISTS deletions int NOT NULL DEFAULT 0;
