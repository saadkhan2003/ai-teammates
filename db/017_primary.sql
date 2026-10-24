-- The account's primary bot: the first bot created, changeable in settings.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
UPDATE bots b SET is_primary = true
WHERE b.id IN (SELECT DISTINCT ON (owner_id) id FROM bots ORDER BY owner_id, created_at)
  AND NOT EXISTS (SELECT 1 FROM bots p WHERE p.owner_id = b.owner_id AND p.is_primary);
CREATE UNIQUE INDEX IF NOT EXISTS bots_one_primary_idx ON bots (owner_id) WHERE is_primary;
