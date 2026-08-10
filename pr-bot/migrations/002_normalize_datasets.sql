CREATE TABLE jobs_migration_002 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL UNIQUE,
    repository TEXT NOT NULL,
    pull_request_number INTEGER NOT NULL,
    pull_request_url TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    datasets_json TEXT NOT NULL CHECK (
        json_valid(datasets_json)
        AND json_type(datasets_json) = 'array'
        AND json_array_length(datasets_json) > 0
    ),
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

INSERT INTO jobs_migration_002 (
    id,
    comment_id,
    repository,
    pull_request_number,
    pull_request_url,
    requested_by,
    datasets_json,
    benchmark_instance_type,
    benchmark_node_count,
    base_sha,
    head_sha,
    status,
    error,
    created_at,
    updated_at,
    attempt_count,
    status_comment_id
)
SELECT
    id,
    comment_id,
    repository,
    pull_request_number,
    pull_request_url,
    requested_by,
    CASE
        WHEN datasets_json IS NULL OR NOT json_valid(datasets_json)
            THEN json_array(dataset)
        WHEN json_type(datasets_json) != 'array' OR json_array_length(datasets_json) = 0
            THEN json_array(dataset)
        WHEN EXISTS (
            SELECT 1 FROM json_each(datasets_json) WHERE json_each.type != 'text'
        )
            THEN json_array(dataset)
        ELSE datasets_json
    END,
    benchmark_instance_type,
    benchmark_node_count,
    base_sha,
    head_sha,
    status,
    error,
    created_at,
    updated_at,
    attempt_count,
    status_comment_id
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_migration_002 RENAME TO jobs;
CREATE INDEX jobs_status_id ON jobs(status, id);
