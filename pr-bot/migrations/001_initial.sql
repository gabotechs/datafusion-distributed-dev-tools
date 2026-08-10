CREATE TABLE IF NOT EXISTS seen_comments (
    comment_id INTEGER PRIMARY KEY,
    seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_state (
    repository TEXT PRIMARY KEY,
    scanned_through TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comment_failures (
    comment_id INTEGER PRIMARY KEY,
    attempts INTEGER NOT NULL,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL UNIQUE,
    repository TEXT NOT NULL,
    pull_request_number INTEGER NOT NULL,
    pull_request_url TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    dataset TEXT NOT NULL,
    benchmark_instance_type TEXT NOT NULL,
    benchmark_node_count INTEGER NOT NULL,
    base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    status_comment_id INTEGER,
    FOREIGN KEY (comment_id) REFERENCES seen_comments(comment_id)
);

CREATE INDEX IF NOT EXISTS jobs_status_id ON jobs(status, id);
