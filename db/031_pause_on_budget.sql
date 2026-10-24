ALTER TABLE bots ADD COLUMN IF NOT EXISTS pause_on_budget boolean NOT NULL DEFAULT true;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pause_on_budget boolean;
