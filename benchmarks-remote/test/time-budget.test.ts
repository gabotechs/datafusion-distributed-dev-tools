import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { S3Client } from "@aws-sdk/client-s3";

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

test("discovers remote table directories when benchmark data is not stored locally", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-empty-table-"));
  const queries = path.join(root, "custom", "queries");
  fs.mkdirSync(path.join(root, "custom", "scale"), { recursive: true });
  fs.mkdirSync(queries, { recursive: true });
  fs.writeFileSync(path.join(queries, "custom.sql"), "select 1");
  const restorePath = installFakeKubectl(root);
  context.mock.method(
    S3Client.prototype as unknown as { send: () => unknown },
    "send",
    async () => ({
      CommonPrefixes: [
        { Prefix: "custom/scale/events/" },
        { Prefix: "custom/scale/users/" },
      ],
    }),
  );

  try {
    let tables: Parameters<BenchmarkRunner["createTables"]>[0] = [];
    const runner: BenchmarkRunner = {
      deployment: "deployment",
      resultName: "test",
      options: options(root, { dataset: "custom/scale" }),
      async createTables(value): Promise<void> {
        tables = value;
      },
      async executeQuery(): Promise<ExecuteQueryResult> {
        return { elapsed: 1, plan: "", rowCount: 1, tasks: 1 };
      },
    };
    await runEngineBenchmark(runner);
    assert.deepEqual(
      tables.map(({ name, s3Path }) => ({ name, s3Path })),
      [
        { name: "events", s3Path: "s3://bucket/custom/scale/events/" },
        { name: "users", s3Path: "s3://bucket/custom/scale/users/" },
      ],
    );
  } finally {
    restorePath();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
