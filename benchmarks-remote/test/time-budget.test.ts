import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { runEngineBenchmark, type CommonOptions } from "../src/lib/engine-cli";
import type { BenchmarkRunner, ExecuteQueryResult } from "../src/lib/runner";

function options(
  root: string,
  overrides: Partial<CommonOptions> = {},
): CommonOptions {
  return {
    bucket: "s3://bucket",
    clusterName: "cluster",
    dataset: "tpch/sf1",
    iterations: 1,
    kubeconfig: path.join(root, "kubeconfig"),
    region: "us-east-1",
    queries: undefined,
    service: "service",
    testdataRoot: root,
    timeSecs: 0,
    url: "http://localhost:9000",
    debug: false,
    warmup: false,
    compare: false,
    ...overrides,
  };
}

function installFakeKubectl(root: string): () => void {
  fs.writeFileSync(path.join(root, "kubeconfig"), "");
  const kubectl = path.join(root, "kubectl");
  fs.writeFileSync(
    kubectl,
    `#!/usr/bin/env node
if (process.argv.includes("config")) {
  process.stdout.write("cluster\\n");
  process.exit(0);
}
process.stdout.write("Forwarding from 127.0.0.1:9000 -> 9000\\n");
setInterval(() => {}, 1_000);
`,
  );
  fs.chmodSync(kubectl, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  return () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  };
}

test("runs each query until both its iteration and time minimums are met", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-time-budget-"));
  const datasetDirectory = path.join(root, "tpch", "sf1", "table");
  const queries = path.join(root, "tpch", "queries");
  fs.mkdirSync(datasetDirectory, { recursive: true });
  fs.mkdirSync(queries, { recursive: true });
  fs.writeFileSync(path.join(datasetDirectory, "1.parquet"), "fixture");
  fs.writeFileSync(path.join(queries, "q1.sql"), "select 1");
  const restorePath = installFakeKubectl(root);

  let elapsedMs = 0;
  let calls = 0;
  context.mock.method(performance, "now", () => elapsedMs);
  const runner: BenchmarkRunner = {
    deployment: "deployment",
    resultName: "test",
    options: options(root, { iterations: 2, timeSecs: 10 }),
    async createTables(): Promise<void> {},
    async executeQuery(): Promise<ExecuteQueryResult> {
      calls += 1;
      elapsedMs += 4_000;
      return { elapsed: 4_000, plan: "", rowCount: 1, tasks: 1 };
    },
  };

  try {
    await runEngineBenchmark(runner);
    assert.equal(calls, 3);
  } finally {
    restorePath();
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
  const restorePath = installFakeKubectl(root);
  const stderr: string[] = [];
  const previousError = console.error;
  const previousExitCode = process.exitCode;
  console.error = (message?: unknown) => stderr.push(String(message));

  try {
    const runner: BenchmarkRunner = {
      deployment: "deployment",
      resultName: "test",
      options: options(root),
      async createTables(): Promise<void> {},
      async executeQuery(): Promise<ExecuteQueryResult> {
        return { elapsed: 1, plan: "", rowCount: 1, tasks: 1 };
      },
    };
    await runEngineBenchmark(runner);
    assert.match(
      stderr.join("\n"),
      /contains no non-empty table directories made entirely of Parquet files/,
    );
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = previousError;
    process.exitCode = previousExitCode;
    restorePath();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
