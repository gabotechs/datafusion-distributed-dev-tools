import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Job } from "../src/database.js";
import {
  BenchmarkExecutor,
  pruneBuildCache,
  safeDatasetPath,
  type ExecutorConfig,
} from "../src/executor.js";
import {
  LocalProcessRunner,
  type ProcessRunner,
  type RunOptions,
  type RunResult,
} from "../src/process.js";

const JOB: Job = {
  id: 7,
  statusCommentId: 99,
  commentId: 10,
  repository: "owner/repository",
  pullRequestNumber: 12,
  pullRequestUrl: "https://example.invalid/pull/12",
  requestedBy: "maintainer",
  datasets: ["tpch/sf1"],
  benchmarkInstanceType: "c7i.2xlarge",
  benchmarkNodeCount: 12,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  status: "running",
  error: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
  attemptCount: 1,
};

const NOOP_PROCESSES: ProcessRunner = {
  async run(): Promise<RunResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};

function fixture(): { root: string; config: ExecutorConfig } {
  const root = mkdtempSync(path.join(tmpdir(), "benchmark-executor-"));
  const outputs = path.join(root, "outputs.json");
  writeFileSync(
    outputs,
    JSON.stringify({
      clusterName: "cluster",
      datasetBucketName: "bucket",
      artifactBucketName: "artifacts",
    }),
  );
  return {
    root,
    config: {
      repositoryUrl: "https://example.invalid/repository.git",
      stateRoot: root,
      workRoot: path.join(root, "work"),
      buildCacheRoot: path.join(root, "build-cache"),
      buildCacheMaxBytes: 1024 ** 3,
      foundationOutputsFile: outputs,
      harnessRoot: path.join(root, "harness"),
      kubeconfig: path.join(root, "kubeconfig"),
      testdataRoot: path.join(root, "testdata"),
      region: "us-east-1",
    },
  };
}

test("executes base before head with the bundled trusted harness", async () => {
  const { config } = fixture();
  const events: string[] = [];
  class RecordingExecutor extends BenchmarkExecutor {
    override async prepareMirror(): Promise<void> {
      events.push("mirror");
    }
    override async removeWorktree(_mirror: string, destination: string) {
      events.push(`remove:${path.basename(destination)}`);
    }
    override async addWorktree(
      _mirror: string,
      destination: string,
      sha: string,
    ) {
      events.push(`add:${path.basename(destination)}:${sha[0]}`);
    }
    override prepareWorker(source: string): void {
      events.push(`prepare-worker:${path.basename(source)}`);
    }
    override resetResults(dataset: string): void {
      events.push(`reset-results:${dataset}`);
    }
    override async prepareDatasetLayout(dataset: string): Promise<void> {
      events.push(`prepare-dataset:${dataset}`);
    }
    override async build(sha: string): Promise<string> {
      events.push(`build:${sha[0]}`);
      return `/binary-${sha[0]}`;
    }
    override async publish(binary: string): Promise<string> {
      events.push(`publish:${binary.at(-1)}`);
      return `s3://bucket/${binary.at(-1)}`;
    }
    override async deploy(
      artifact: string,
      _outputs: Parameters<BenchmarkExecutor["deploy"]>[1],
      job: Job,
    ): Promise<void> {
      events.push(
        `deploy:${artifact.at(-1)}:${job.benchmarkInstanceType}:${job.benchmarkNodeCount}`,
      );
    }
    override async runBenchmark(
      dataset: string,
      jobId: number,
      engine: string,
    ): Promise<void> {
      events.push(`run:${jobId}:${dataset}:${engine}`);
    }
    override async compareResults(dataset: string): Promise<string> {
      events.push(`compare:${dataset}`);
      return `comparison:${dataset}`;
    }
    override async cleanupDeployment(
      _outputs: Parameters<BenchmarkExecutor["cleanupDeployment"]>[0],
      jobId: number,
    ) {
      events.push(`cleanup-deployment:${jobId}`);
    }
  }

  const datasets = ["tpch/sf1", "tpch/sf10", "tpch/sf100"];
  const progress: string[] = [];
  const result = await new RecordingExecutor(config, NOOP_PROCESSES).execute(
    {
      ...JOB,
      datasets,
    },
    async ({ step, totalSteps, message }) => {
      progress.push(`${step}/${totalSteps}:${message}`);
    },
  );
  assert.equal(
    result.comparison,
    datasets.map((dataset) => `comparison:${dataset}`).join("\n\n"),
  );
  assert.deepEqual(
    result.timings.baseBenchmarks.map(({ dataset }) => dataset),
    datasets,
  );
  assert.deepEqual(
    result.timings.headBenchmarks.map(({ dataset }) => dataset),
    datasets,
  );
  assert.ok(result.timings.totalMs >= 0);
  assert.deepEqual(progress, [
    "1/12:Validating all requested datasets",
    "2/12:Preparing immutable base and PR source checkouts",
    "3/12:Compiling the base revision",
    "4/12:Provisioning the base Kubernetes deployment and compiling the PR head",
    "5/12:Benchmarking base: tpch/sf1",
    "6/12:Benchmarking base: tpch/sf10",
    "7/12:Benchmarking base: tpch/sf100",
    "8/12:Provisioning the PR-head Kubernetes deployment",
    "9/12:Benchmarking PR head: tpch/sf1",
    "10/12:Benchmarking PR head: tpch/sf10",
    "11/12:Benchmarking PR head: tpch/sf100",
    "12/12:Cleaning up the isolated deployment and worktrees",
  ]);
  assert.deepEqual(events, [
    "prepare-dataset:tpch/sf1",
    "prepare-dataset:tpch/sf10",
    "prepare-dataset:tpch/sf100",
    "mirror",
    "remove:head",
    "remove:base",
    "add:base:a",
    "add:head:b",
    "prepare-worker:base",
    "prepare-worker:head",
    "reset-results:tpch/sf1",
    "reset-results:tpch/sf10",
    "reset-results:tpch/sf100",
    "build:a",
    "publish:a",
    "build:b",
    "deploy:a:c7i.2xlarge:12",
    "publish:b",
    "run:7:tpch/sf1:datafusion-distributed-aaaaaaaaaaaa",
    "run:7:tpch/sf10:datafusion-distributed-aaaaaaaaaaaa",
    "run:7:tpch/sf100:datafusion-distributed-aaaaaaaaaaaa",
    "deploy:b:c7i.2xlarge:12",
    "run:7:tpch/sf1:datafusion-distributed-bbbbbbbbbbbb",
    "compare:tpch/sf1",
    "run:7:tpch/sf10:datafusion-distributed-bbbbbbbbbbbb",
    "compare:tpch/sf10",
    "run:7:tpch/sf100:datafusion-distributed-bbbbbbbbbbbb",
    "compare:tpch/sf100",
    "cleanup-deployment:7",
    "remove:head",
    "remove:base",
  ]);
});

test("validates every dataset before build or deployment", async () => {
  const { config } = fixture();
  const events: string[] = [];
  class ValidationExecutor extends BenchmarkExecutor {
    override async prepareDatasetLayout(dataset: string): Promise<void> {
      events.push(`validate:${dataset}`);
      if (dataset === "tpch/sf10") throw new Error("dataset unavailable");
    }
    override async prepareMirror(): Promise<void> {
      events.push("mirror");
    }
    override async build(): Promise<string> {
      events.push("build");
      return "/binary";
    }
    override async deploy(): Promise<void> {
      events.push("deploy");
    }
    override async cleanupDeployment(): Promise<void> {
      events.push("cleanup-deployment");
    }
  }

  await assert.rejects(
    new ValidationExecutor(config, NOOP_PROCESSES).execute({
      ...JOB,
      datasets: ["tpch/sf1", "tpch/sf10", "tpch/sf100"],
    }),
    /dataset unavailable/,
  );
  assert.deepEqual(events, ["validate:tpch/sf1", "validate:tpch/sf10"]);
});

test("preserves base-deployment failure precedence in the concurrent phase", async () => {
  const { config } = fixture();
  const events: string[] = [];
  class ConcurrentFailureExecutor extends BenchmarkExecutor {
    override async prepareDatasetLayout(): Promise<void> {}
    override async prepareMirror(): Promise<void> {}
    override async removeWorktree(): Promise<void> {}
    override async addWorktree(): Promise<void> {}
    override prepareWorker(): void {}
    override async prepareSourcePermissions(): Promise<void> {}
    override resetResults(): void {}
    override async build(sha: string): Promise<string> {
      if (sha === JOB.headSha) {
        events.push("head-build-failed");
        throw new Error("head build failed");
      }
      return "/base-binary";
    }
    override async publish(): Promise<string> {
      return "s3://artifacts/base";
    }
    override async deploy(): Promise<void> {
      events.push("base-deploy-failed");
      throw new Error("base deployment failed");
    }
    override async cleanupDeployment(): Promise<void> {
      events.push("cleanup-deployment");
    }
  }

  await assert.rejects(
    new ConcurrentFailureExecutor(config, NOOP_PROCESSES).execute(JOB),
    /base deployment failed/,
  );
  assert.deepEqual(events, [
    "head-build-failed",
    "base-deploy-failed",
    "cleanup-deployment",
  ]);
});

test("uses request capacity in an isolated per-job Helm release", async () => {
  const { config } = fixture();
  const calls: Array<{ program: string; arguments_: readonly string[] }> = [];
  const processes: ProcessRunner = {
    async run(program, arguments_): Promise<RunResult> {
      calls.push({ program, arguments_ });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const executor = new BenchmarkExecutor(config, processes);
  const outputs = {
    clusterName: "cluster",
    datasetBucketName: "datasets",
    artifactBucketName: "artifacts",
  };

  await executor.deploy("s3://artifacts/worker", outputs, JOB);
  await executor.cleanupDeployment(outputs, JOB.id);

  assert.equal(calls[0]?.program, "helm");
  assert.equal(calls[0]?.arguments_[2], "datafusion-job-7");
  assert.ok(calls[0]?.arguments_.includes("worker.replicas=12"));
  assert.ok(calls[0]?.arguments_.includes("worker.instanceType=c7i.2xlarge"));
  assert.ok(calls[0]?.arguments_.includes("name=datafusion-job-7"));
  assert.deepEqual(calls[1]?.arguments_.slice(0, 3), [
    "uninstall",
    "datafusion-job-7",
    "--namespace",
  ]);
});

test("runs benchmarks with the selected engine name without comparing results", async () => {
  const { config } = fixture();
  let program: string | undefined;
  let arguments_: readonly string[] | undefined;
  let options: RunOptions | undefined;
  const processes: ProcessRunner = {
    async run(runProgram, runArguments, runOptions): Promise<RunResult> {
      program = runProgram;
      arguments_ = runArguments;
      options = runOptions;
      return { exitCode: 0, stdout: "ignored output", stderr: "" };
    },
  };
  const engine = "datafusion-distributed-deadbeef1234";

  await new BenchmarkExecutor(config, processes).runBenchmark(
    "tpch/sf1",
    JOB.id,
    engine,
  );

  assert.equal(program, "node");
  const argument = (name: string): string | undefined =>
    arguments_?.[arguments_.indexOf(name) + 1];
  assert.equal(argument("--engine"), engine);
  assert.equal(argument("--deployment"), "datafusion");
  assert.equal(argument("--bucket"), "s3://bucket");
  assert.equal(argument("--cluster-name"), "cluster");
  assert.equal(argument("--service"), "datafusion-job-7");
  assert.equal(argument("--kubeconfig"), config.kubeconfig);
  assert.equal(argument("--region"), config.region);
  assert.equal(argument("--testdata-root"), config.testdataRoot);
  assert.ok(arguments_?.includes("--no-compare"));
  assert.equal(options?.env, undefined);
});

test("reads comparisons generated from stored result files", async () => {
  const { config, root } = fixture();
  let program: string | undefined;
  let arguments_: readonly string[] | undefined;
  let options: RunOptions | undefined;
  const processes: ProcessRunner = {
    async run(runProgram, runArguments, runOptions): Promise<RunResult> {
      program = runProgram;
      arguments_ = runArguments;
      options = runOptions;
      const output = runArguments[runArguments.indexOf("--output") + 1]!;
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, "comparison from files\n");
      return { exitCode: 0, stdout: "ignored", stderr: "" };
    },
  };
  const output = path.join(root, "reports", "tpch-sf1.txt");

  const comparison = await new BenchmarkExecutor(
    config,
    processes,
  ).compareResults(
    "tpch/sf1",
    "datafusion-distributed-aaaaaaaaaaaa",
    "datafusion-distributed-bbbbbbbbbbbb",
    output,
  );

  assert.equal(comparison, "comparison from files\n");
  assert.equal(program, "node");
  assert.ok(arguments_?.[0]?.endsWith("/dist/compare.cjs"));
  assert.deepEqual(arguments_?.slice(1), [
    "--dataset",
    "tpch/sf1",
    "--output",
    output,
    "--testdata-root",
    config.testdataRoot,
    "datafusion-distributed-aaaaaaaaaaaa",
    "datafusion-distributed-bbbbbbbbbbbb",
  ]);
  assert.equal(options?.env, undefined);
});

test("removes stale per-job releases when the controller starts", async () => {
  const { config } = fixture();
  const calls: Array<{ program: string; arguments_: readonly string[] }> = [];
  const processes: ProcessRunner = {
    async run(program, arguments_): Promise<RunResult> {
      calls.push({ program, arguments_ });
      return {
        exitCode: 0,
        stdout:
          arguments_[0] === "list"
            ? "datafusion-job-3\ndatafusion-job-19\n"
            : "",
        stderr: "",
      };
    },
  };

  await new BenchmarkExecutor(config, processes).cleanup();

  assert.equal(calls[0]?.arguments_[0], "list");
  assert.deepEqual(
    calls.slice(1).map((call) => call.arguments_[1]),
    ["datafusion-job-3", "datafusion-job-19"],
  );
});

test("rejects dataset paths that could escape testdata", () => {
  assert.equal(
    safeDatasetPath("/testdata", "tpch/sf1"),
    path.resolve("/testdata/tpch/sf1"),
  );
  assert.throws(() => safeDatasetPath("/testdata", "../secret"));
  assert.throws(() => safeDatasetPath("/testdata", "tpch/sf1/extra"));
});

test("overlays the trusted worker and base queries onto historical revisions", () => {
  const { config, root } = fixture();
  const source = path.join(root, "source");
  const trustedWorker = path.join(
    config.harnessRoot,
    "engines/datafusion/src/main.rs",
  );
  const targetWorker = path.join(source, "benchmarks/cdk/bin/worker.rs");
  const sourceQueries = path.join(source, "testdata/tpch/queries");
  const previousRun = path.join(
    config.testdataRoot,
    "tpch/sf1/.results-remote/previous-run.json",
  );
  for (const directory of [
    path.dirname(trustedWorker),
    path.dirname(targetWorker),
    sourceQueries,
    path.dirname(previousRun),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(trustedWorker, "trusted worker");
  writeFileSync(targetWorker, "revision worker");
  writeFileSync(path.join(sourceQueries, "q1.sql"), "select 1");
  writeFileSync(previousRun, "stale manifest");

  const executor = new BenchmarkExecutor(config, NOOP_PROCESSES);
  executor.prepareWorker(source);
  executor.resetResults("tpch/sf1", source);

  assert.equal(readFileSync(targetWorker, "utf8"), "trusted worker");
  assert.equal(
    readFileSync(path.join(config.testdataRoot, "tpch/queries/q1.sql"), "utf8"),
    "select 1",
  );
  assert.equal(existsSync(previousRun), false);
});

test("uses native cache, fetch, and offline build wrappers", async () => {
  const { config } = fixture();
  const source = path.join(config.workRoot, "jobs", "7", "head");
  mkdirSync(source, { recursive: true });
  const calls: Array<{
    program: string;
    arguments_: readonly string[];
    options: RunOptions | undefined;
  }> = [];
  const processes: ProcessRunner = {
    async run(program, arguments_, options): Promise<RunResult> {
      calls.push({ program, arguments_, options });
      if (arguments_[0] === "/usr/local/sbin/datafusion-pr-prepare-cache") {
        mkdirSync(arguments_[1]!, { recursive: true });
        mkdirSync(arguments_[2]!, { recursive: true });
      }
      if (arguments_[0] === "/usr/local/sbin/datafusion-pr-cargo-build") {
        const target = arguments_[2]!;
        const binaryDirectory = path.join(
          target,
          "x86_64-unknown-linux-gnu",
          "release",
        );
        mkdirSync(binaryDirectory, { recursive: true });
        writeFileSync(path.join(binaryDirectory, "worker"), "binary");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await new BenchmarkExecutor(config, processes).build(
    "b".repeat(40),
    source,
    "untrusted",
    "a".repeat(40),
  );
  assert.deepEqual(
    calls.map((call) => [call.program, call.arguments_[0]]),
    [
      ["sudo", "/usr/local/sbin/datafusion-pr-prepare-cache"],
      ["sudo", "/usr/local/sbin/datafusion-pr-cargo-fetch"],
      ["sudo", "/usr/local/sbin/datafusion-pr-cargo-build"],
    ],
  );
  assert.match(calls[0]!.arguments_[1]!, /targets\/untrusted-b{40}$/);
  assert.match(calls[0]!.arguments_[3]!, /targets\/trusted-a{40}$/);
  assert.match(calls[0]!.arguments_[4]!, /cargo\/trusted-a{40}$/);
  assert.equal(calls[2]!.options?.outputTailBytes, 128 * 1024);
});

test("shares worktree sources read-only with the isolated build account", async () => {
  const { config } = fixture();
  const calls: Array<{ program: string; arguments_: readonly string[] }> = [];
  const processes: ProcessRunner = {
    async run(program, arguments_): Promise<RunResult> {
      calls.push({ program, arguments_ });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const jobRoot = path.join(config.workRoot, "jobs", "7");
  await new BenchmarkExecutor(config, processes).prepareSourcePermissions(
    jobRoot,
  );
  assert.deepEqual(calls, [
    {
      program: "chgrp",
      arguments_: ["--recursive", "benchmark-cache", "--", jobRoot],
    },
    {
      program: "chmod",
      arguments_: ["--recursive", "g+rX", "--", jobRoot],
    },
  ]);
});

test("rejects non-SHA Git operands", async () => {
  const { config } = fixture();
  await assert.rejects(
    new BenchmarkExecutor(config, NOOP_PROCESSES).addWorktree(
      "mirror",
      "destination",
      "--help",
    ),
    /Invalid Git commit SHA/,
  );
});

test("prunes the least-recently-used SHA cache first", () => {
  const { root } = fixture();
  const cache = path.join(root, "cache");
  const oldSha = `trusted-${"a".repeat(40)}`;
  const newSha = `untrusted-${"b".repeat(40)}`;
  for (const sha of [oldSha, newSha]) {
    const directory = path.join(cache, "targets", sha);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "artifact"), "0123456789");
  }
  utimesSync(
    path.join(cache, "targets", oldSha),
    new Date("2026-01-01"),
    new Date("2026-01-01"),
  );
  utimesSync(
    path.join(cache, "targets", newSha),
    new Date("2026-02-01"),
    new Date("2026-02-01"),
  );
  pruneBuildCache(cache, 10);
  assert.equal(existsSync(path.join(cache, "targets", oldSha)), false);
  assert.equal(existsSync(path.join(cache, "targets", newSha)), true);
});

test("discovers table directories without downloading dataset objects", async () => {
  const { config } = fixture();
  const calls: { program: string; arguments_: readonly string[] }[] = [];
  const processes: ProcessRunner = {
    async run(program, arguments_): Promise<RunResult> {
      calls.push({ program, arguments_ });
      return {
        exitCode: 0,
        stdout: JSON.stringify(["tpch/sf1/customer/", "tpch/sf1/orders/"]),
        stderr: "",
      };
    },
  };
  await new BenchmarkExecutor(config, processes).prepareDatasetLayout(
    "tpch/sf1",
    "datasets",
  );
  assert.ok(existsSync(path.join(config.testdataRoot, "tpch/sf1/customer")));
  assert.ok(existsSync(path.join(config.testdataRoot, "tpch/sf1/orders")));
  assert.ok(
    existsSync(
      path.join(
        config.testdataRoot,
        "tpch/sf1/customer/.remote-layout.parquet",
      ),
    ),
  );
  assert.equal(calls[0]?.program, "aws");
  assert.ok(calls[0]?.arguments_.includes("list-objects-v2"));
  assert.ok(!calls[0]?.arguments_.includes("s3"));
});

test("local process execution does not invoke a shell", async () => {
  const value = "$(printf shell-expanded)";
  const result = await new LocalProcessRunner().run(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1])", value],
    { quiet: true },
  );
  assert.equal(result.stdout, value);
});

test("local process execution retains only a bounded output tail", async () => {
  const result = await new LocalProcessRunner().run(
    process.execPath,
    ["-e", 'process.stdout.write("earlier-" + "x".repeat(10_000) + "-tail")'],
    { quiet: true, outputTailBytes: 32 },
  );

  assert.ok(Buffer.byteLength(result.stdout) <= 32);
  assert.match(result.stdout, /-tail$/);
  assert.doesNotMatch(result.stdout, /earlier/);
});

test("process failures report only the configured output tail", async () => {
  await assert.rejects(
    new LocalProcessRunner().run(
      process.execPath,
      [
        "-e",
        'process.stderr.write("earlier-" + "x".repeat(10_000) + "-failure-tail"); process.exit(2)',
      ],
      { quiet: true, outputTailBytes: 64 },
    ),
    (error: Error) => {
      assert.match(error.message, /-failure-tail$/);
      assert.doesNotMatch(error.message, /earlier/);
      return true;
    },
  );
});
