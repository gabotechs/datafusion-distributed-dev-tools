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

test("runs each query until both its iteration and time minimums are met", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-time-budget-"));
    const datasetDirectory = path.join(root, "tpch", "sf1", "table");
    const queries = path.join(root, "tpch", "queries");
    fs.mkdirSync(datasetDirectory, {recursive: true});
    fs.mkdirSync(queries, {recursive: true});
    fs.writeFileSync(path.join(datasetDirectory, "1.parquet"), "fixture");
    fs.writeFileSync(path.join(queries, "q1.sql"), "select 1");

    const previousRoot = process.env.BENCHMARK_TESTDATA_ROOT;
    const previousBucket = process.env.BENCHMARK_BUCKET;
    const previousCompare = process.env.BENCHMARK_COMPARE;
    process.env.BENCHMARK_TESTDATA_ROOT = root;
    process.env.BENCHMARK_BUCKET = "s3://bucket";
    process.env.BENCHMARK_COMPARE = "false";

    let elapsedMs = 0;
    let calls = 0;
    const runner: BenchmarkRunner = {
        async createTables(): Promise<void> {},
        async executeQuery(): Promise<ExecuteQueryResult> {
            calls += 1;
            elapsedMs += 4_000;
            return {elapsed: 4_000, plan: "", rowCount: 1, tasks: 1};
        },
    };

    try {
        await runBenchmark(runner, {
            dataset: "tpch/sf1",
            engine: "test",
            iterations: 2,
            timeSecs: 10,
            queries: [],
            debug: false,
            warmup: false,
            now: () => elapsedMs,
        });
        assert.equal(calls, 3);
    } finally {
        if (previousRoot === undefined) delete process.env.BENCHMARK_TESTDATA_ROOT;
        else process.env.BENCHMARK_TESTDATA_ROOT = previousRoot;
        if (previousBucket === undefined) delete process.env.BENCHMARK_BUCKET;
        else process.env.BENCHMARK_BUCKET = previousBucket;
        if (previousCompare === undefined) delete process.env.BENCHMARK_COMPARE;
        else process.env.BENCHMARK_COMPARE = previousCompare;
        fs.rmSync(root, {recursive: true, force: true});
    }
});
