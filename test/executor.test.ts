import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Job } from "../src/database.js";
import {
  BenchmarkExecutor,
  copyOnWrite,
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
  commentId: 10,
  repository: "owner/repository",
  pullRequestNumber: 12,
  pullRequestUrl: "https://example.invalid/pull/12",
  requestedBy: "maintainer",
  dataset: "tpch/sf1",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  status: "running",
  error: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
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
      benchmarkInstanceType: "c5n.2xlarge",
      benchmarkNodeCount: 12,
    }),
  );
  return {
    root,
    config: {
      repositoryUrl: "https://example.invalid/repository.git",
      stateRoot: root,
      builderImage: "builder:fixed",
      foundationOutputsFile: outputs,
      kubeconfig: path.join(root, "kubeconfig"),
      testdataRoot: path.join(root, "testdata"),
      containerRuntime: "podman",
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
    override async deploy(baseSource: string, artifact: string): Promise<void> {
      events.push(`deploy:${path.basename(baseSource)}:${artifact.at(-1)}`);
    }
    override async runBenchmark(
      baseSource: string,
      dataset: string,
    ): Promise<string> {
      events.push(`run:${path.basename(baseSource)}:${dataset}`);
      return "comparison";
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
    "deploy:base:a",
    "run:base:tpch/sf1",
    "build:b",
    "publish:b",
    "deploy:base:b",
    "run:base:tpch/sf1",
    "remove:head",
    "remove:base",
  ]);
});

test("copies cache contents into an isolated destination", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "benchmark-cache-"));
  const source = path.join(root, "base");
  const destination = path.join(root, "head");
  mkdirSync(source);
  writeFileSync(path.join(source, "artifact"), "cached");
  const calls: { program: string; arguments_: readonly string[] }[] = [];
  const processes: ProcessRunner = {
    async run(
      program: string,
      arguments_: readonly string[],
      _options?: RunOptions,
    ): Promise<RunResult> {
      calls.push({ program, arguments_ });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await copyOnWrite(processes, source, destination);
  assert.deepEqual(calls, [
    {
      program: "cp",
      arguments_: [
        "--archive",
        "--reflink=auto",
        `${source}${path.sep}.`,
        `${destination}${path.sep}`,
      ],
    },
  ]);
});

test("rejects dataset paths that could escape testdata", () => {
  assert.equal(
    safeDatasetPath("/testdata", "tpch/sf1"),
    path.resolve("/testdata/tpch/sf1"),
  );
  assert.throws(() => safeDatasetPath("/testdata", "../secret"));
  assert.throws(() => safeDatasetPath("/testdata", "tpch/sf1/extra"));
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
