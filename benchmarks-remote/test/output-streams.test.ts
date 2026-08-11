import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSync } from "@optique/run";

import {
  commonOptions,
  runEngineBenchmark,
  type CommonOptions as CommonOptionValues,
} from "../src/lib/engine-cli";
import type { BenchmarkRunner, ExecuteQueryResult } from "../src/lib/runner";

class FakeRunner implements BenchmarkRunner {
  constructor(
    readonly engine: string,
    readonly options: CommonOptionValues,
  ) {}

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

function parseOptions(argv: readonly string[]): CommonOptionValues {
  const parser = commonOptions("test", () => ({
    bucket: "s3://bucket",
    clusterName: "cluster",
    region: "us-east-1",
  }));
  return runSync<typeof parser>(parser, {
    args: argv.slice(2),
    help: "option",
    programName: argv[1] ?? "benchmark",
    showDefault: true,
  });
}

test("uses the local foundation and engine for omitted connection options", () => {
  const parser = commonOptions("datafusion", () => ({
    bucket: "s3://datasets",
    clusterName: "benchmark-cluster",
    region: "eu-west-1",
  }));
  const options = runSync<typeof parser>(parser, {
    args: ["--dataset", "tpch/sf1"],
    help: "option",
    programName: "datafusion-bench",
    showDefault: true,
  });

  assert.equal(options.bucket, "s3://datasets");
  assert.equal(options.clusterName, "benchmark-cluster");
  assert.equal(options.deployment, "datafusion");
  assert.equal(options.region, "eu-west-1");
  assert.equal(options.service, "datafusion");
});

test("rejects explicitly empty query selections", async () => {
  const stderr: string[] = [];
  const previousError = console.error;
  const previousExitCode = process.exitCode;
  console.error = (message?: unknown) => stderr.push(String(message));
  try {
    await runEngineBenchmark(
      new FakeRunner(
        "test",
        parseOptions([
          "node",
          "benchmark",
          "--bucket",
          "s3://bucket",
          "--cluster-name",
          "cluster",
          "--dataset",
          "tpch/sf1",
          "--deployment",
          "test",
          "--queries",
          " , ",
          "--service",
          "test",
        ]),
      ),
    );
    assert.match(
      stderr.join("\n"),
      /--queries must contain at least one query ID/,
    );
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = previousError;
    process.exitCode = previousExitCode;
  }
});

test("writes progress to stderr and only explicit comparisons to stdout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-output-"));
  const dataset = path.join(root, "tpch", "sf1", "table");
  const queries = path.join(root, "tpch", "queries");
  fs.mkdirSync(dataset, { recursive: true });
  fs.mkdirSync(queries, { recursive: true });
  fs.writeFileSync(path.join(dataset, "1.parquet"), "fixture");
  fs.writeFileSync(path.join(queries, "q1.sql"), "select 1");
  const kubeconfig = path.join(root, "kubeconfig");
  const kubectl = path.join(root, "kubectl");
  fs.writeFileSync(kubeconfig, "");
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
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousLog = console.log;
  const previousError = console.error;
  process.env.PATH = `${root}:${process.env.PATH ?? ""}`;
  console.log = (message?: unknown) => stdout.push(String(message));
  console.error = (message?: unknown) => stderr.push(String(message));

  try {
    const commonArguments = [
      "node",
      "benchmark",
      "--bucket",
      "s3://bucket",
      "--cluster-name",
      "cluster",
      "--dataset",
      "tpch/sf1",
      "--deployment",
      "test",
      "--kubeconfig",
      kubeconfig,
      "--service",
      "test",
      "--testdata-root",
      root,
      "--iterations",
      "1",
      "--warmup",
      "false",
    ];
    await runEngineBenchmark(
      new FakeRunner(
        "base",
        parseOptions([...commonArguments, "--no-compare"]),
      ),
    );
    assert.deepEqual(stdout, []);

    await runEngineBenchmark(
      new FakeRunner("head", parseOptions(commonArguments)),
    );
    assert.match(stderr.join("\n"), /Query q1 iteration 0 took 10 ms/);
    assert.match(stdout.join("\n"), /^=== Comparing tpch\/sf1/);
    assert.match(stdout.join("\n"), /TOTAL:/);
    assert.doesNotMatch(
      stdout.join("\n"),
      /Creating tables|iteration 0|p50 time/,
    );
  } finally {
    console.log = previousLog;
    console.error = previousError;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
