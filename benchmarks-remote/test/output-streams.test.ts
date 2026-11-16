import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { runSync } from "@optique/run";
import { S3Client } from "@aws-sdk/client-s3";

import {
  CommonOptions,
  runEngineBenchmark,
  type CommonOptions as CommonOptionValues,
} from "../src/lib/engine-cli";
import type { BenchmarkRunner, ExecuteQueryResult } from "../src/lib/runner";

const TPCH_SF1 =
  "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false";

class FakeRunner implements BenchmarkRunner {
  readonly deployment = "test";
  calls = 0;

  constructor(
    readonly resultName: string,
    readonly options: CommonOptionValues,
    private readonly planDumps = false,
  ) {}

  async createTables(): Promise<void> {}

  async executeQuery(): Promise<ExecuteQueryResult> {
    this.calls += 1;
    return {
      elapsed: 10,
      plan: `plan-${this.calls}`,
      ...(this.planDumps ? { planDump: `dump-${this.calls}` } : {}),
      rowCount: 1,
      tasks: 1,
    };
  }
}

function parseOptions(argv: readonly string[]): CommonOptionValues {
  return runSync<typeof CommonOptions>(CommonOptions, {
    args: argv.slice(2),
    help: "option",
    programName: argv[1] ?? "benchmark",
    showDefault: true,
  });
}

test("resolves a pre-parameter-encoded dataset alias from the command line", () => {
  const options = parseOptions([
    "node",
    "benchmark",
    "--bucket",
    "s3://bucket",
    "--k8s-cluster",
    "cluster",
    "tpch/sf1",
  ]);
  assert.equal(options.dataset, TPCH_SF1);
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
          "--k8s-cluster",
          "cluster",
          TPCH_SF1,
          "--queries",
          " , ",
        ]),
      ),
    );
    assert.match(
      stderr.join("\n"),
      /--query must contain at least one query ID/,
    );
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = previousError;
    process.exitCode = previousExitCode;
  }
});

interface Harness {
  root: string;
  stdout: string[];
  stderr: string[];
  arguments_: (...extra: string[]) => CommonOptionValues;
}

/** Runs `body` against a fake cluster, capturing both output streams. */
async function withHarness(
  context: TestContext,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-output-"));
  const queries = path.join(root, "tpch", "queries");
  fs.mkdirSync(queries, { recursive: true });
  fs.writeFileSync(path.join(queries, "q1.sql"), "select 1");
  context.mock.method(
    S3Client.prototype,
    "send",
    async (command: { input: { Prefix: string } }) =>
      command.input.Prefix === `${TPCH_SF1}/`
        ? { CommonPrefixes: [{ Prefix: `${TPCH_SF1}/table/` }] }
        : { Contents: [{ Key: `${TPCH_SF1}/table/1.parquet` }] },
  );
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
  console.log = (message?: unknown) => stdout.push(`${String(message)}\n`);
  console.error = (message?: unknown) => stderr.push(String(message));
  try {
    await body({
      root,
      stdout,
      stderr,
      arguments_: (...extra) =>
        parseOptions([
          "node",
          "benchmark",
          "--bucket",
          "s3://bucket",
          "--k8s-cluster",
          "cluster",
          TPCH_SF1,
          "--kubeconfig",
          kubeconfig,
          "--testdata-root",
          root,
          ...extra,
        ]),
    });
  } finally {
    console.log = previousLog;
    console.error = previousError;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("writes progress and comparisons to stderr, leaving stdout empty", async (context) => {
  await withHarness(context, async ({ stdout, stderr, arguments_ }) => {
    const options = ["--iterations", "1", "--warmup", "false"];
    await runEngineBenchmark(
      new FakeRunner("base", arguments_(...options, "--no-compare"), true),
    );
    await runEngineBenchmark(
      new FakeRunner("head", arguments_(...options), true),
    );
    assert.deepEqual(stdout, []);
    const errors = stderr.join("\n");
    assert.match(errors, /Query q1 iteration 0 took 10 ms/);
    assert.match(errors, /=== Comparing tpch_parquet\/scale_factor=1/);
    assert.match(errors, /TOTAL:/);
  });
});

test("--debug warms up, then prints one plan dump line per measured iteration", async (context) => {
  await withHarness(context, async ({ stdout, stderr, arguments_ }) => {
    const runner = new FakeRunner(
      "debug",
      arguments_("-d", "--no-compare"),
      true,
    );
    await runEngineBenchmark(runner);
    // The warmup is call 1 and prints nothing; the single measured iteration is call 2.
    assert.equal(runner.calls, 2);
    assert.deepEqual(stdout, ["dump-2\n"]);
    assert.ok(stderr.includes("plan-2"));
    assert.ok(!stderr.includes("plan-1"));

    stdout.length = 0;
    const repeated = new FakeRunner(
      "debug",
      arguments_("--debug", "-i", "3", "--warmup", "false", "--no-compare"),
      true,
    );
    await runEngineBenchmark(repeated);
    assert.deepEqual(stdout, ["dump-1\n", "dump-2\n", "dump-3\n"]);
  });
});

test("--debug reports engines without plan dumps on stderr only", async (context) => {
  await withHarness(context, async ({ stdout, stderr, arguments_ }) => {
    await runEngineBenchmark(
      new FakeRunner("debug", arguments_("-d", "-i", "2", "--no-compare")),
    );
    assert.deepEqual(stdout, []);
    assert.equal(
      stderr.filter((line) => /did not return a plan dump/.test(line)).length,
      1,
    );
  });
});
