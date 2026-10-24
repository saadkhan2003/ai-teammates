-- A short bio/title shown under the bot name (e.g. "Personal Chief of Staff"), max 60 chars.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT '';
