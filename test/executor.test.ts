import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
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
  type RunResult,
} from "../src/process.js";

const JOB: Job = {
  id: 7,
  commentId: 10,
  repository: "owner/repository",
  pullRequestNumber: 12,
  pullRequestUrl: "https://example.invalid/pull/12",
  requestedBy: "maintainer",
  dataset: "tpch/sf1",
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
      kubeconfig: path.join(root, "kubeconfig"),
      testdataRoot: path.join(root, "testdata"),
      region: "us-east-1",
    },
  };
}

test("executes base before head and always uses the trusted base harness", async () => {
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
    override async installHarness(): Promise<void> {
      events.push("install-harness");
    }
    override resetResults(): void {
      events.push("reset-results");
    }
    override async prepareDatasetLayout(): Promise<void> {
      events.push("prepare-dataset");
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
      baseSource: string,
      artifact: string,
      _outputs: Parameters<BenchmarkExecutor["deploy"]>[2],
      job: Job,
    ): Promise<void> {
      events.push(
        `deploy:${path.basename(baseSource)}:${artifact.at(-1)}:${job.benchmarkInstanceType}:${job.benchmarkNodeCount}`,
      );
    }
    override async runBenchmark(
      baseSource: string,
      dataset: string,
    ): Promise<string> {
      events.push(`run:${path.basename(baseSource)}:${dataset}`);
      return "comparison";
    }
    override async cleanupDeployment(
      _outputs: Parameters<BenchmarkExecutor["cleanupDeployment"]>[0],
      jobId: number,
    ) {
      events.push(`cleanup-deployment:${jobId}`);
    }
  }

  const result = await new RecordingExecutor(config, NOOP_PROCESSES).execute(
    JOB,
  );
  assert.equal(result.comparison, "comparison");
  assert.deepEqual(events, [
    "mirror",
    "remove:head",
    "remove:base",
    "add:base:a",
    "add:head:b",
    "install-harness",
    "reset-results",
    "prepare-dataset",
    "build:a",
    "publish:a",
    "deploy:base:a:c7i.2xlarge:12",
    "run:base:tpch/sf1",
    "build:b",
    "publish:b",
    "deploy:base:b:c7i.2xlarge:12",
    "run:base:tpch/sf1",
    "cleanup-deployment:7",
    "remove:head",
    "remove:base",
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

  await executor.deploy("/trusted", "s3://artifacts/worker", outputs, JOB);
  await executor.cleanupDeployment(outputs, JOB.id);

  assert.equal(calls[0]?.program, "helm");
  assert.equal(calls[0]?.arguments_[2], "datafusion-job-7");
  assert.ok(calls[0]?.arguments_.includes("worker.replicas=12"));
  assert.ok(calls[0]?.arguments_.includes("worker.instanceType=c7i.2xlarge"));
  assert.deepEqual(calls[1]?.arguments_.slice(0, 3), [
    "uninstall",
    "datafusion-job-7",
    "--namespace",
  ]);
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

test("uses native cache, fetch, and offline build wrappers", async () => {
  const { config } = fixture();
  const source = path.join(config.workRoot, "jobs", "7", "head");
  mkdirSync(source, { recursive: true });
  const calls: Array<{ program: string; arguments_: readonly string[] }> = [];
  const processes: ProcessRunner = {
    async run(program, arguments_): Promise<RunResult> {
      calls.push({ program, arguments_ });
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
