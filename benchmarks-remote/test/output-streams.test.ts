import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    BenchmarkRunner,
    ExecuteQueryResult,
    runBenchmark,
} from "../src/@bench-common";

class FakeRunner implements BenchmarkRunner {
    async createTables(): Promise<void> {}

    async executeQuery(): Promise<ExecuteQueryResult> {
        return {
            elapsed: 10,
            plan: "plan",
            rowCount: 1,
            tasks: 1,
        };
    }
}

test("writes progress to stderr and only comparisons to stdout", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-output-"));
    const dataset = path.join(root, "tpch", "sf1", "table");
    const queries = path.join(root, "tpch", "queries");
    fs.mkdirSync(dataset, { recursive: true });
    fs.mkdirSync(queries, { recursive: true });
    fs.writeFileSync(path.join(dataset, "1.parquet"), "fixture");
    fs.writeFileSync(path.join(queries, "q1.sql"), "select 1");

    const previousRoot = process.env.BENCHMARK_TESTDATA_ROOT;
    const previousBucket = process.env.BENCHMARK_BUCKET;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const previousLog = console.log;
    const previousError = console.error;
    process.env.BENCHMARK_TESTDATA_ROOT = root;
    process.env.BENCHMARK_BUCKET = "s3://bucket";
    console.log = (message?: unknown) => stdout.push(String(message));
    console.error = (message?: unknown) => stderr.push(String(message));

    try {
        const options = {
            dataset: "tpch/sf1",
            iterations: 1,
            timeSecs: 0,
            queries: [] as string[],
            debug: false,
            warmup: false,
        };
        await runBenchmark(new FakeRunner(), { ...options, engine: "base" });
        assert.deepEqual(stdout, []);

        await runBenchmark(new FakeRunner(), { ...options, engine: "head" });
        assert.match(stderr.join("\n"), /Query q1 iteration 0 took 10 ms/);
        assert.match(stdout.join("\n"), /^=== Comparing tpch\/sf1/);
        assert.match(stdout.join("\n"), /TOTAL:/);
        assert.doesNotMatch(stdout.join("\n"), /Creating tables|iteration 0|p50 time/);
    } finally {
        console.log = previousLog;
        console.error = previousError;
        if (previousRoot === undefined) delete process.env.BENCHMARK_TESTDATA_ROOT;
        else process.env.BENCHMARK_TESTDATA_ROOT = previousRoot;
        if (previousBucket === undefined) delete process.env.BENCHMARK_BUCKET;
        else process.env.BENCHMARK_BUCKET = previousBucket;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
