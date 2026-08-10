import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBenchmark } from "../src/lib/run-benchmark";
import type { BenchmarkRunner, ExecuteQueryResult } from "../src/lib/runner";

test("runs each query until both its iteration and time minimums are met", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-time-budget-"));
  const datasetDirectory = path.join(root, "tpch", "sf1", "table");
  const queries = path.join(root, "tpch", "queries");
  fs.mkdirSync(datasetDirectory, { recursive: true });
  fs.mkdirSync(queries, { recursive: true });
  fs.writeFileSync(path.join(datasetDirectory, "1.parquet"), "fixture");
  fs.writeFileSync(path.join(queries, "q1.sql"), "select 1");

  const previousRoot = process.env.BENCHMARK_TESTDATA_ROOT;
  const previousBucket = process.env.BENCHMARK_BUCKET;
  process.env.BENCHMARK_TESTDATA_ROOT = root;
  process.env.BENCHMARK_BUCKET = "s3://bucket";

  let elapsedMs = 0;
  let calls = 0;
  const runner: BenchmarkRunner = {
    async createTables(): Promise<void> {},
    async executeQuery(): Promise<ExecuteQueryResult> {
      calls += 1;
      elapsedMs += 4_000;
      return { elapsed: 4_000, plan: "", rowCount: 1, tasks: 1 };
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
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects datasets whose table directories contain no Parquet files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-empty-table-"));
  const datasetDirectory = path.join(root, "tpch", "sf1", "table");
  const queries = path.join(root, "tpch", "queries");
  fs.mkdirSync(datasetDirectory, { recursive: true });
  fs.mkdirSync(queries, { recursive: true });
  fs.writeFileSync(path.join(queries, "custom.sql"), "select 1");

  const previousRoot = process.env.BENCHMARK_TESTDATA_ROOT;
  const previousBucket = process.env.BENCHMARK_BUCKET;
  process.env.BENCHMARK_TESTDATA_ROOT = root;
  process.env.BENCHMARK_BUCKET = "s3://bucket";
  try {
    const runner: BenchmarkRunner = {
      async createTables(): Promise<void> {},
      async executeQuery(): Promise<ExecuteQueryResult> {
        return { elapsed: 1, plan: "", rowCount: 1, tasks: 1 };
      },
    };
    await assert.rejects(
      () =>
        runBenchmark(runner, {
          dataset: "tpch/sf1",
          engine: "test",
          iterations: 1,
          timeSecs: 0,
          queries: [],
          debug: false,
          warmup: false,
        }),
      /contains no non-empty table directories made entirely of Parquet files/,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.BENCHMARK_TESTDATA_ROOT;
    else process.env.BENCHMARK_TESTDATA_ROOT = previousRoot;
    if (previousBucket === undefined) delete process.env.BENCHMARK_BUCKET;
    else process.env.BENCHMARK_BUCKET = previousBucket;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
