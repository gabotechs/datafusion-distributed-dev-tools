import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Job } from "../src/database.js";
import {
  BenchmarkExecutor,
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
      sourceRoot: path.join(root, "datafusion-distributed"),
      foundationOutputsFile: outputs,
      harnessRoot: path.join(
        root,
        "datafusion-distributed-dev-tools/benchmarks-remote",
      ),
      kubeconfig: path.join(root, "kubeconfig"),
      region: "us-east-1",
    },
  };
}

test("checks out and deploys base then head through the shared harness", async () => {
  const { config } = fixture();
  const events: string[] = [];
  class RecordingExecutor extends BenchmarkExecutor {
    override async checkoutRevision(sha: string) {
      events.push(`checkout:${sha[0]}`);
    }
    override async prepareDatasetLayout(dataset: string): Promise<void> {
      events.push(`prepare-dataset:${dataset}`);
    }
    override async deploy(
      _outputs: Parameters<BenchmarkExecutor["deploy"]>[0],
      job: Job,
    ): Promise<void> {
      events.push(
        `deploy:${job.benchmarkInstanceType}:${job.benchmarkNodeCount}`,
      );
    }
    override async runBenchmark(
      dataset: string,
      resultName: string,
    ): Promise<void> {
      events.push(`run:${dataset}:${resultName}`);
    }
    override async compareResults(dataset: string): Promise<string> {
      events.push(`compare:${dataset}`);
      return `comparison:${dataset}`;
    }
    override async cleanupDeployment(): Promise<void> {
      events.push("cleanup-deployment");
    }
  }

  const datasets = ["tpch/sf1", "tpch/sf10"];
  const progress: string[] = [];
  const result = await new RecordingExecutor(config, NOOP_PROCESSES).execute(
    { ...JOB, datasets },
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
  assert.deepEqual(progress, [
    "1/10:Checking out the base revision",
    "2/10:Validating all requested datasets",
    "3/10:Deploying the base revision",
    "4/10:Benchmarking base: tpch/sf1",
    "5/10:Benchmarking base: tpch/sf10",
    "6/10:Checking out the PR-head revision",
    "7/10:Deploying the PR-head revision",
    "8/10:Benchmarking PR head: tpch/sf1",
    "9/10:Benchmarking PR head: tpch/sf10",
    "10/10:Destroying the benchmark deployment",
  ]);
  assert.deepEqual(events, [
    "checkout:a",
    "prepare-dataset:tpch/sf1",
    "prepare-dataset:tpch/sf10",
    "deploy:c7i.2xlarge:12",
    "run:tpch/sf1:datafusion-benchmark-base",
    "run:tpch/sf10:datafusion-benchmark-base",
    "checkout:b",
    "deploy:c7i.2xlarge:12",
    "run:tpch/sf1:datafusion-benchmark-head",
    "compare:tpch/sf1",
    "run:tpch/sf10:datafusion-benchmark-head",
    "compare:tpch/sf10",
    "cleanup-deployment",
  ]);
});

test("stops before deployment when dataset validation fails", async () => {
  const { config } = fixture();
  const events: string[] = [];
  class ValidationExecutor extends BenchmarkExecutor {
    override async checkoutRevision(): Promise<void> {
      events.push("checkout");
    }
    override async prepareDatasetLayout(dataset: string): Promise<void> {
      events.push(`validate:${dataset}`);
      if (dataset === "tpch/sf10") throw new Error("dataset unavailable");
    }
    override async deploy(): Promise<void> {
      events.push("deploy");
    }
    override async cleanupDeployment(): Promise<void> {
      events.push("cleanup");
    }
  }

  await assert.rejects(
    new ValidationExecutor(config, NOOP_PROCESSES).execute({
      ...JOB,
      datasets: ["tpch/sf1", "tpch/sf10", "tpch/sf100"],
    }),
    /dataset unavailable/,
  );
  assert.deepEqual(events, [
    "checkout",
    "validate:tpch/sf1",
    "validate:tpch/sf10",
    "cleanup",
  ]);
});

test("uses the shared named deployment command for deploy and cleanup", async () => {
  const { config } = fixture();
  const calls: Array<{
    program: string;
    arguments_: readonly string[];
    options: RunOptions | undefined;
  }> = [];
  const processes: ProcessRunner = {
    async run(program, arguments_, options): Promise<RunResult> {
      calls.push({ program, arguments_, options });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const executor = new BenchmarkExecutor(config, processes);
  const outputs = {
    clusterName: "cluster",
    datasetBucketName: "datasets",
    artifactBucketName: "artifacts",
  };

  await executor.deploy(outputs, JOB);
  await executor.cleanupDeployment(outputs);

  assert.deepEqual(
    calls.map(({ program, arguments_ }) => [program, ...arguments_]),
    [
      ["npm", "run", "datafusion-deploy"],
      ["npm", "run", "datafusion-destroy"],
    ],
  );
  assert.equal(calls[0]?.options?.cwd, config.harnessRoot);
  assert.equal(
    calls[0]?.options?.env?.DEPLOYMENT_NAME,
    "datafusion-benchmark-bot",
  );
  assert.equal(calls[0]?.options?.env?.NODE_COUNT, "12");
  assert.equal(calls[0]?.options?.env?.BENCHMARK_INSTANCE_TYPE, "c7i.2xlarge");
  assert.equal(calls[0]?.options?.env?.WORKER_ARTIFACT_BUCKET, "artifacts");
  assert.equal(
    calls[0]?.options?.env?.DATAFUSION_BUILD_WRAPPER,
    "/usr/local/sbin/datafusion-pr-build",
  );
  assert.equal(calls[1]?.options?.allowFailure, true);
});

test("fetches and checks out each immutable revision in the adjacent clone", async () => {
  const { config } = fixture();
  const calls: Array<{ program: string; arguments_: readonly string[] }> = [];
  const processes: ProcessRunner = {
    async run(program, arguments_): Promise<RunResult> {
      calls.push({ program, arguments_ });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  await new BenchmarkExecutor(config, processes).checkoutRevision(JOB.baseSha);

  assert.deepEqual(calls, [
    {
      program: "git",
      arguments_: [
        "-C",
        config.sourceRoot,
        "remote",
        "set-url",
        "origin",
        config.repositoryUrl,
      ],
    },
    {
      program: "git",
      arguments_: [
        "-C",
        config.sourceRoot,
        "fetch",
        "--force",
        "--no-tags",
        "origin",
        JOB.baseSha,
      ],
    },
    {
      program: "git",
      arguments_: [
        "-C",
        config.sourceRoot,
        "checkout",
        "--detach",
        "--force",
        JOB.baseSha,
      ],
    },
  ]);
});

test("runs benchmarks against the shared deployment and adjacent testdata", async () => {
  const { config } = fixture();
  let arguments_: readonly string[] = [];
  const processes: ProcessRunner = {
    async run(_program, runArguments): Promise<RunResult> {
      arguments_ = runArguments;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  await new BenchmarkExecutor(config, processes).runBenchmark(
    "tpch/sf1",
    "datafusion-benchmark-base",
  );

  const argument = (name: string): string | undefined =>
    arguments_[arguments_.indexOf(name) + 1];
  assert.equal(argument("--k8s-service"), "datafusion-benchmark-bot");
  assert.equal(argument("--iterations"), "5");
  assert.equal(argument("--warmup"), "true");
  assert.equal(
    argument("--testdata-root"),
    path.join(config.sourceRoot, "testdata"),
  );
  assert.equal(argument("--result-name"), "datafusion-benchmark-base");
});

test("reads comparison output directly from the shared client", async () => {
  const { config } = fixture();
  let options: RunOptions | undefined;
  const processes: ProcessRunner = {
    async run(_program, _arguments, runOptions): Promise<RunResult> {
      options = runOptions;
      return {
        exitCode: 0,
        stdout: "comparison from stdout\n",
        stderr: "",
      };
    },
  };

  const comparison = await new BenchmarkExecutor(
    config,
    processes,
  ).compareResults("tpch/sf1", "base", "head");

  assert.equal(comparison, "comparison from stdout\n");
  assert.equal(options?.quiet, true);
});

test("rejects dataset paths that could escape testdata", () => {
  assert.equal(
    safeDatasetPath("/testdata", "tpch/sf1"),
    path.resolve("/testdata/tpch/sf1"),
  );
  assert.throws(() => safeDatasetPath("/testdata", "../secret"));
  assert.throws(() => safeDatasetPath("/testdata", "tpch/sf1/extra"));
});

test("recreates table placeholders from the selected dataset", async () => {
  const { config } = fixture();
  const datasetRoot = path.join(config.sourceRoot, "testdata/tpch/sf1");
  mkdirSync(path.join(datasetRoot, "stale"), { recursive: true });
  writeFileSync(path.join(datasetRoot, "stale/old.parquet"), "stale");
  const processes: ProcessRunner = {
    async run(): Promise<RunResult> {
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

  assert.equal(existsSync(path.join(datasetRoot, "stale")), false);
  assert.ok(
    existsSync(path.join(datasetRoot, "customer/.remote-layout.parquet")),
  );
  assert.ok(
    existsSync(path.join(datasetRoot, "orders/.remote-layout.parquet")),
  );
});

test("rejects non-SHA Git revisions", async () => {
  const { config } = fixture();
  await assert.rejects(
    new BenchmarkExecutor(config, NOOP_PROCESSES).checkoutRevision("--help"),
    /Invalid Git commit SHA/,
  );
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
