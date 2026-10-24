-- Origin finished-job card diff stats, after v0.5 and the reserved migration slots.
ALTER TABLE coding_jobs ADD COLUMN IF NOT EXISTS branch text NOT NULL DEFAULT '';
ALTER TABLE coding_jobs ADD COLUMN IF NOT EXISTS files_changed int NOT NULL DEFAULT 0;
ALTER TABLE coding_jobs ADD COLUMN IF NOT EXISTS additions int NOT NULL DEFAULT 0;
ALTER TABLE coding_jobs ADD COLUMN IF NOT EXISTS deletions int NOT NULL DEFAULT 0;
