ALTER TABLE jobs ADD COLUMN benchmark_queries_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(benchmark_queries_json) AND json_type(benchmark_queries_json) = 'array');
