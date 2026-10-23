CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS library_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    source text NOT NULL DEFAULT 'artifact',
    direction text NOT NULL DEFAULT 'out' CHECK (direction IN ('in','out')),
    name text NOT NULL,
    ext text NOT NULL DEFAULT '',
    mime text NOT NULL DEFAULT 'application/octet-stream',
    kind text NOT NULL DEFAULT 'unknown',
    size_bytes bigint NOT NULL DEFAULT 0,
    sha256 text NOT NULL,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
    page_id uuid,
    message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    thumb_key text,
    thumb_state text NOT NULL DEFAULT 'none' CHECK (thumb_state IN ('pending','ready','none','failed')),
    width integer,
    height integer,
    duration_ms integer,
    pinned_at timestamptz,
    shared text NOT NULL DEFAULT 'private' CHECK (shared IN ('private','link')),
    share_token_hash text,
    dlp_state text NOT NULL DEFAULT 'clean' CHECK (dlp_state IN ('clean','redacted','blocked')),
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS library_items_bot_created_idx ON library_items(bot_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS library_items_bot_kind_created_idx ON library_items(bot_id, kind, created_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS library_items_bot_sha_name_idx ON library_items(bot_id, sha256, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS library_items_name_trgm_idx ON library_items USING gin (name gin_trgm_ops);

INSERT INTO library_items(bot_id, source, direction, name, ext, mime, kind, size_bytes, sha256, artifact_id, task_id, created_at)
SELECT a.bot_id, CASE WHEN a.name LIKE 'evidence-%' AND a.mime LIKE 'image/%' THEN 'screenshot'
                      WHEN a.name LIKE 'evidence-%' AND a.mime LIKE 'video/%' THEN 'recording'
                      ELSE 'artifact' END,
       'out', a.name, CASE WHEN position('.' in a.name) > 0 THEN lower(regexp_replace(a.name, '^.*\.', '')) ELSE '' END,
       a.mime,
       CASE
         WHEN a.name LIKE 'evidence-%' AND a.mime LIKE 'image/%' THEN 'screenshots'
         WHEN lower(a.name) ~ '\.(png|jpe?g|gif|webp|bmp|heic)$' THEN 'image'
         WHEN lower(a.name) ~ '\.(mp4|webm|mov|mkv)$' OR a.mime LIKE 'video/%' THEN 'video'
         WHEN lower(a.name) ~ '\.(mp3|wav|ogg|m4a)$' OR a.mime LIKE 'audio/%' THEN 'audio'
         WHEN lower(a.name) LIKE '%.pdf' OR a.mime='application/pdf' THEN 'pdf'
         WHEN lower(a.name) ~ '\.(csv|tsv|xls|xlsx|ods)$' OR a.mime LIKE '%spreadsheet%' OR a.mime='text/csv' THEN 'sheet'
         WHEN lower(a.name) ~ '\.(md|markdown)$' OR a.mime='text/markdown' THEN 'markdown'
         WHEN lower(a.name) ~ '\.(txt|log)$' OR a.mime LIKE 'text/%' THEN 'text'
         WHEN lower(a.name) ~ '\.(html?|css|m?js|tsx?|jsx?|py|cs|json|xml|ya?ml|sh|sql)$' OR a.mime IN ('application/json','application/xml') THEN 'code'
         WHEN lower(a.name) ~ '\.(docx?|odt|pptx?)$' OR a.mime LIKE '%wordprocessing%' OR a.mime='application/msword' THEN 'doc'
         WHEN lower(a.name) ~ '\.(zip|tar|gz|7z|rar)$' OR a.mime LIKE '%compressed%' OR a.mime='application/zip' THEN 'archive'
         ELSE 'unknown'
       END,
       a.size_bytes, a.sha256, a.id, a.task_id, a.created_at
FROM (SELECT DISTINCT ON (bot_id, sha256, name) * FROM artifacts ORDER BY bot_id, sha256, name, created_at DESC, id DESC) a
ON CONFLICT DO NOTHING;
