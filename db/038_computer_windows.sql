CREATE TABLE IF NOT EXISTS computer_windows (
    computer_id uuid NOT NULL,
    window_index int NOT NULL CHECK (window_index BETWEEN 2 AND 8),
    state text NOT NULL DEFAULT 'starting' CHECK (state IN ('starting', 'ready', 'failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (computer_id, window_index)
);
