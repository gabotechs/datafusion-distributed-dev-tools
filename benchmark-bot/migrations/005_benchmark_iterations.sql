ALTER TABLE jobs ADD COLUMN benchmark_iterations INTEGER NOT NULL DEFAULT 5
    CHECK (
        typeof(benchmark_iterations) = 'integer'
        AND benchmark_iterations BETWEEN 1 AND 9007199254740991
    );
