ALTER TABLE tasks ADD COLUMN IF NOT EXISTS force_compact boolean NOT NULL DEFAULT false;
