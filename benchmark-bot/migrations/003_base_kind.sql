ALTER TABLE jobs ADD COLUMN base_kind TEXT NOT NULL DEFAULT 'pull-request'
    CHECK (base_kind IN ('pull-request', 'main'));
