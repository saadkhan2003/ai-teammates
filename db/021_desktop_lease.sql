-- Durable, per-computer display lease. All expiry decisions use PostgreSQL time.
-- API mutations are single-statement compare-and-swap updates with `WHERE epoch = @expectedEpoch`.
CREATE TABLE desktop_lease (
    computer_id uuid NOT NULL,
    display integer NOT NULL CHECK (display BETWEEN 1 AND 2),
    holder_kind text NOT NULL DEFAULT 'none' CHECK (holder_kind IN ('none', 'agent', 'human')),
    holder_user_id uuid,
    tab_id text,
    epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (computer_id, display),
    CHECK ((holder_kind = 'none' AND holder_user_id IS NULL AND tab_id IS NULL)
        OR (holder_kind <> 'none' AND holder_user_id IS NOT NULL))
);

CREATE INDEX desktop_lease_expiry_idx ON desktop_lease (expires_at)
    WHERE holder_kind <> 'none';

-- Start existing desktops with a reconciliable agent lease at the current provider epoch.
INSERT INTO desktop_lease (computer_id, display, holder_kind, holder_user_id, epoch, expires_at, updated_at)
SELECT uc.computer_id, 1, 'agent', uc.user_id,
       GREATEST(COALESCE(cl.epoch, 1), 1), clock_timestamp() + interval '90 seconds', clock_timestamp()
FROM user_computers uc
LEFT JOIN control_locks cl ON cl.bot_id=uc.desktop_bot_id
ON CONFLICT (computer_id, display) DO NOTHING;
