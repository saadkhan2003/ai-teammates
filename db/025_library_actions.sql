ALTER TABLE library_items
  ADD COLUMN IF NOT EXISTS thumb_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS thumb_retry_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS library_items_thumb_pending_idx
  ON library_items(thumb_retry_at, created_at)
  WHERE thumb_state = 'pending' AND deleted_at IS NULL;
UPDATE library_items
SET thumb_state = 'pending', thumb_retry_at = now()
WHERE thumb_state = 'none' AND artifact_id IS NOT NULL AND deleted_at IS NULL
  AND kind IN ('image', 'screenshots', 'video', 'pdf');
