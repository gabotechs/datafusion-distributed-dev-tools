import { createHash } from "node:crypto";
import {
  createReadStream,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Job } from "./database.js";
import type { ProcessRunner } from "./process.js";

interface FoundationOutputs {
  clusterName: string;
  datasetBucketName: string;
  artifactBucketName: string;
}

export interface ExecutorConfig {
  repositoryUrl: string;
  stateRoot: string;
  workRoot: string;
  buildCacheRoot: string;
  buildCacheMaxBytes: number;
  foundationOutputsFile: string;
  harnessRoot: string;
  kubeconfig: string;
  testdataRoot: string;
  region: string;
}

export interface ExecutionResult {
  comparison: string;
  baseArtifact: string;
  headArtifact: string;
  timings: ExecutionTimings;
}

export interface BenchmarkTiming {
  dataset: string;
  durationMs: number;
}

export interface ExecutionTimings {
  validationMs: number;
  baseCompileMs: number;
  baseDeployMs: number;
  baseBenchmarks: BenchmarkTiming[];
  headCompileMs: number;
  headDeployMs: number;
  headBenchmarks: BenchmarkTiming[];
  totalMs: number;
}

export interface ExecutionProgress {
  step: number;
  totalSteps: number;
  message: string;
}

export type ProgressReporter = (progress: ExecutionProgress) => Promise<void>;

export class BenchmarkExecutor {
  constructor(
    readonly config: ExecutorConfig,
    readonly processes: ProcessRunner,
  ) {}

  async execute(
    job: Job,
    onProgress: ProgressReporter = async () => {},
  ): Promise<ExecutionResult> {
    const executionStarted = performance.now();
    const timings: ExecutionTimings = {
      validationMs: 0,
      baseCompileMs: 0,
      baseDeployMs: 0,
      baseBenchmarks: [],
      headCompileMs: 0,
      headDeployMs: 0,
      headBenchmarks: [],
      totalMs: 0,
    };
    validateSha(job.baseSha);
    validateSha(job.headSha);
    if (job.datasets.length === 0) {
      throw new Error(`Benchmark job ${job.id} has no datasets`);
    }
    const outputs = loadOutputs(this.config.foundationOutputsFile);
    const mirror = path.join(this.config.stateRoot, "repository.git");
    const jobRoot = path.join(this.config.workRoot, "jobs", String(job.id));
    const baseSource = path.join(jobRoot, "base");
    const headSource = path.join(jobRoot, "head");
    let deploymentStarted = false;
    let progressStep = 0;
    const totalProgressSteps = 7 + 2 * job.datasets.length;
    const reportProgress = async (message: string): Promise<void> => {
      await onProgress({
        step: ++progressStep,
        totalSteps: totalProgressSteps,
        message,
      });
    };
    mkdirSync(jobRoot, { recursive: true });

    try {
      await reportProgress("Validating all requested datasets");
      const validationStarted = performance.now();
      for (const dataset of job.datasets) {
        await this.prepareDatasetLayout(dataset, outputs.datasetBucketName);
      }
      timings.validationMs = performance.now() - validationStarted;
      await reportProgress("Preparing immutable base and PR source checkouts");
      await this.prepareMirror(mirror);
      await this.removeWorktree(mirror, headSource);
      await this.removeWorktree(mirror, baseSource);
      await this.addWorktree(mirror, baseSource, job.baseSha);
      await this.addWorktree(mirror, headSource, job.headSha);
      this.prepareWorker(baseSource);
      this.prepareWorker(headSource);
      await this.prepareSourcePermissions(jobRoot);
      for (const dataset of job.datasets) {
        this.resetResults(dataset, baseSource);
      }

      await reportProgress("Compiling the base revision");
      const baseCompileStarted = performance.now();
      const baseBinary = await this.build(
        job.baseSha,
        baseSource,
        "trusted",
        undefined,
      );
      timings.baseCompileMs = performance.now() - baseCompileStarted;
      const baseArtifact = await this.publish(
        baseBinary,
        outputs.artifactBucketName,
      );
      deploymentStarted = true;
      await reportProgress("Provisioning the base Kubernetes deployment");
      const baseDeployStarted = performance.now();
      await this.deploy(baseArtifact, outputs, job);
      timings.baseDeployMs = performance.now() - baseDeployStarted;
      for (const dataset of job.datasets) {
        await reportProgress(`Benchmarking base: ${dataset}`);
        const benchmarkStarted = performance.now();
        await this.runBenchmark(dataset, job.id, baseSource);
        timings.baseBenchmarks.push({
          dataset,
          durationMs: performance.now() - benchmarkStarted,
        });
      }

      await reportProgress("Compiling the PR head");
      const headCompileStarted = performance.now();
      const headBinary = await this.build(
        job.headSha,
        headSource,
        "untrusted",
        job.baseSha,
      );
      timings.headCompileMs = performance.now() - headCompileStarted;
      const headArtifact = await this.publish(
        headBinary,
        outputs.artifactBucketName,
      );
      await reportProgress("Provisioning the PR-head Kubernetes deployment");
      const headDeployStarted = performance.now();
      await this.deploy(headArtifact, outputs, job);
      timings.headDeployMs = performance.now() - headDeployStarted;
      const comparisons: string[] = [];
      for (const dataset of job.datasets) {
        await reportProgress(`Benchmarking PR head: ${dataset}`);
        const benchmarkStarted = performance.now();
        comparisons.push(await this.runBenchmark(dataset, job.id, headSource));
        timings.headBenchmarks.push({
          dataset,
          durationMs: performance.now() - benchmarkStarted,
        });
      }
      const comparison = comparisons
        .map((value) => value.trim())
        .filter(Boolean)
        .join("\n\n");

      return { comparison, baseArtifact, headArtifact, timings };
    } finally {
      await reportProgress("Cleaning up the isolated deployment and worktrees");
      if (deploymentStarted) {
        await this.cleanupDeployment(outputs, job.id);
      }
      await this.removeWorktree(mirror, headSource);
      await this.removeWorktree(mirror, baseSource);
      rmSync(jobRoot, { recursive: true, force: true });
      pruneBuildCache(
        this.config.buildCacheRoot,
        this.config.buildCacheMaxBytes,
        new Set([`trusted-${job.baseSha}`, `untrusted-${job.headSha}`]),
      );
      timings.totalMs = performance.now() - executionStarted;
    }
  }

  async cleanup(): Promise<void> {
    const outputs = loadOutputs(this.config.foundationOutputsFile);
    const result = await this.processes.run(
      "helm",
      [
        "list",
        "--namespace",
        "benchmark-datafusion",
        "--kube-context",
        outputs.clusterName,
        "--filter",
        "^datafusion-job-[0-9]+$",
        "--short",
      ],
      {
        allowFailure: true,
        env: { ...process.env, KUBECONFIG: this.config.kubeconfig },
      },
    );
    if (result.exitCode !== 0) return;
    for (const release of result.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const match = /^datafusion-job-([0-9]+)$/.exec(release);
      if (match) await this.cleanupDeployment(outputs, Number(match[1]));
    }
  }

  async prepareMirror(mirror: string): Promise<void> {
    if (!existsSync(mirror)) {
      mkdirSync(path.dirname(mirror), { recursive: true });
      await this.processes.run("git", [
        "clone",
        "--mirror",
        this.config.repositoryUrl,
        mirror,
      ]);
    }
    await this.processes.run("git", [
      "--git-dir",
      mirror,
      "remote",
      "update",
      "--prune",
    ]);
  }

  async addWorktree(
    mirror: string,
    destination: string,
    sha: string,
  ): Promise<void> {
    validateSha(sha);
    await this.processes.run("git", [
      "--git-dir",
      mirror,
      "worktree",
      "add",
      "--detach",
      "--",
      destination,
      sha,
    ]);
  }

  async removeWorktree(mirror: string, destination: string): Promise<void> {
    if (!existsSync(destination)) return;
    await this.processes.run(
      "git",
      ["--git-dir", mirror, "worktree", "remove", "--force", destination],
      { allowFailure: true },
    );
  }

  prepareWorker(source: string): void {
    const trustedWorker = path.join(
      this.config.harnessRoot,
      "engines",
      "datafusion",
      "src",
      "main.rs",
    );
    const targetWorker = path.join(
      source,
      "benchmarks",
      "cdk",
      "bin",
      "worker.rs",
    );
    if (!existsSync(trustedWorker)) {
      throw new Error(`Trusted worker source is missing: ${trustedWorker}`);
    }
    if (!existsSync(targetWorker)) {
      throw new Error(
        `Source revision does not provide the compatible benchmark worker target: ${targetWorker}`,
      );
    }
    cpSync(trustedWorker, targetWorker);
  }

  async prepareSourcePermissions(jobRoot: string): Promise<void> {
    await this.processes.run("chgrp", [
      "--recursive",
      "benchmark-cache",
      "--",
      jobRoot,
    ]);
    await this.processes.run("chmod", ["--recursive", "g+rX", "--", jobRoot]);
  }

  resetResults(dataset: string, baseSource: string): void {
    const datasetDirectory = safeDatasetPath(this.config.testdataRoot, dataset);
    rmSync(path.join(datasetDirectory, "previous-remote.json"), {
      force: true,
    });
    rmSync(path.join(datasetDirectory, ".results-remote"), {
      recursive: true,
      force: true,
    });

    const sourceQueries = path.join(
      baseSource,
      "testdata",
      dataset.split("/")[0]!,
      "queries",
    );
    if (!existsSync(sourceQueries)) {
      throw new Error(`Trusted base does not contain queries for ${dataset}`);
    }
    const targetQueries = path.join(
      this.config.testdataRoot,
      dataset.split("/")[0]!,
      "queries",
    );
    rmSync(targetQueries, { recursive: true, force: true });
    cpSync(sourceQueries, targetQueries, { recursive: true });
  }

  async prepareDatasetLayout(dataset: string, bucket: string): Promise<void> {
    const datasetDirectory = safeDatasetPath(this.config.testdataRoot, dataset);
    mkdirSync(datasetDirectory, { recursive: true });
    const prefix = `${dataset}/`;
    const result = await this.processes.run(
      "aws",
      [
        "--region",
        this.config.region,
        "s3api",
        "list-objects-v2",
        "--bucket",
        bucket,
        "--prefix",
        prefix,
        "--delimiter",
        "/",
        "--query",
        "CommonPrefixes[].Prefix",
        "--output",
        "json",
      ],
      { quiet: true },
    );
    const prefixes = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(prefixes) || prefixes.length === 0) {
      throw new Error(`Dataset ${dataset} has no table prefixes in S3`);
    }
    for (const value of prefixes) {
      if (typeof value !== "string" || !value.startsWith(prefix)) {
        throw new Error(`Invalid S3 table prefix for ${dataset}`);
      }
      const table = value.slice(prefix.length).replace(/\/$/, "");
      if (!/^[a-zA-Z0-9._-]+$/.test(table)) {
        throw new Error(`Invalid S3 table name ${table}`);
      }
      mkdirSync(path.join(datasetDirectory, table), { recursive: true });
    }
  }

  async build(
    sha: string,
    source: string,
    trust: "trusted" | "untrusted",
    seedSha: string | undefined,
  ): Promise<string> {
    validateSha(sha);
    if (seedSha) validateSha(seedSha);
    const cacheRoot = this.config.buildCacheRoot;
    const cacheKey = `${trust}-${sha}`;
    const target = path.join(cacheRoot, "targets", cacheKey);
    const cargoHome = path.join(cacheRoot, "cargo", cacheKey);
    const seedKey = seedSha ? `trusted-${seedSha}` : "";
    const seedTarget = seedKey ? path.join(cacheRoot, "targets", seedKey) : "";
    const seedCargoHome = seedKey ? path.join(cacheRoot, "cargo", seedKey) : "";
    await this.processes.run("sudo", [
      "/usr/local/sbin/datafusion-pr-prepare-cache",
      target,
      cargoHome,
      seedTarget,
      seedCargoHome,
    ]);
    await this.processes.run("sudo", [
      "/usr/local/sbin/datafusion-pr-cargo-fetch",
      source,
      target,
      cargoHome,
    ]);
    await this.processes.run("sudo", [
      "/usr/local/sbin/datafusion-pr-cargo-build",
      source,
      target,
      cargoHome,
    ]);

    const binary = path.join(
      target,
      "x86_64-unknown-linux-gnu",
      "release",
      "worker",
    );
    if (!existsSync(binary)) {
      throw new Error(`Build completed without producing ${binary}`);
    }
    return binary;
  }

  async publish(binary: string, bucket: string): Promise<string> {
    const digest = await sha256(binary);
    const key = `workers/datafusion/${digest}/worker`;
    const artifact = `s3://${bucket}/${key}`;
    const exists = await this.processes.run(
      "aws",
      [
        "--region",
        this.config.region,
        "s3api",
        "head-object",
        "--bucket",
        bucket,
        "--key",
        key,
      ],
      { allowFailure: true, quiet: true },
    );
    if (exists.exitCode !== 0) {
      await this.processes.run("aws", [
        "--region",
        this.config.region,
        "s3",
        "cp",
        binary,
        artifact,
      ]);
    }
    return artifact;
  }

  async deploy(
    artifact: string,
    outputs: FoundationOutputs,
    job: Job,
  ): Promise<void> {
    await this.processes.run(
      "helm",
      [
        "upgrade",
        "--install",
        deploymentName(job.id),
        path.join(this.config.harnessRoot, "k8s", "datafusion"),
        "--namespace",
        "benchmark-datafusion",
        "--kube-context",
        outputs.clusterName,
        "--values",
        path.join(this.config.harnessRoot, "k8s", "worker-resources.yaml"),
        "--set-string",
        `worker.artifact=${artifact}`,
        "--set-string",
        `worker.datasetBucket=${outputs.datasetBucketName}`,
        "--set-string",
        `worker.replicas=${job.benchmarkNodeCount}`,
        "--set-string",
        `worker.instanceType=${job.benchmarkInstanceType}`,
        "--set-string",
        `name=${deploymentName(job.id)}`,
        "--rollback-on-failure",
        "--cleanup-on-fail",
        "--wait",
        "--timeout",
        "25m",
      ],
      { env: { ...process.env, KUBECONFIG: this.config.kubeconfig } },
    );
  }

  async cleanupDeployment(
    outputs: FoundationOutputs,
    jobId: number,
  ): Promise<void> {
    await this.processes.run(
      "helm",
      [
        "uninstall",
        deploymentName(jobId),
        "--namespace",
        "benchmark-datafusion",
        "--kube-context",
        outputs.clusterName,
        "--ignore-not-found",
        "--wait",
        "--timeout",
        "10m",
      ],
      {
        allowFailure: true,
        env: { ...process.env, KUBECONFIG: this.config.kubeconfig },
      },
    );
  }

  async runBenchmark(
    dataset: string,
    jobId: number,
    sourceRoot: string,
  ): Promise<string> {
    const result = await this.processes.run(
      "bash",
      [
        path.join(this.config.harnessRoot, "k8s", "run-benchmark.sh"),
        "datafusion",
        "--dataset",
        dataset,
      ],
      {
        cwd: this.config.harnessRoot,
        env: {
          ...process.env,
          AWS_REGION: this.config.region,
          BENCHMARK_RUNNER: path.join(
            this.config.harnessRoot,
            "dist",
            "datafusion-bench.cjs",
          ),
          BENCHMARK_SERVICE_NAME: deploymentName(jobId),
          BENCHMARK_TESTDATA_ROOT: this.config.testdataRoot,
          DATAFUSION_DISTRIBUTED_ROOT: sourceRoot,
          KUBECONFIG: this.config.kubeconfig,
          PULUMI_OUTPUTS_FILE: this.config.foundationOutputsFile,
        },
      },
    );
    return result.stdout;
  }
}

function loadOutputs(file: string): FoundationOutputs {
  const value = JSON.parse(
    readFileSync(file, "utf8"),
  ) as Partial<FoundationOutputs>;
  if (
    !value.clusterName ||
    !value.datasetBucketName ||
    !value.artifactBucketName
  ) {
    throw new Error(`Invalid foundation outputs in ${file}`);
  }
  return value as FoundationOutputs;
}

function deploymentName(jobId: number): string {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new Error(`Invalid benchmark job ID ${jobId}`);
  }
  return `datafusion-job-${jobId}`;
}

export function safeDatasetPath(root: string, dataset: string): string {
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(dataset)) {
    throw new Error(`Invalid dataset ${dataset}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, dataset);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Dataset escapes testdata root: ${dataset}`);
  }
  return resolved;
}

export function validateSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Invalid Git commit SHA ${sha}`);
  }
}

interface CacheEntry {
  sha: string;
  bytes: number;
  modifiedMs: number;
}

export function pruneBuildCache(
  cacheRoot: string,
  maxBytes: number,
  protectedShas = new Set<string>(),
): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !existsSync(cacheRoot)) {
    return;
  }
  const entries = new Map<string, CacheEntry>();
  for (const kind of ["targets", "cargo"]) {
    const directory = path.join(cacheRoot, kind);
    if (!existsSync(directory)) continue;
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (
        !child.isDirectory() ||
        !/^(trusted|untrusted)-[0-9a-f]{40}$/.test(child.name)
      ) {
        continue;
      }
      const childPath = path.join(directory, child.name);
      const current = entries.get(child.name) ?? {
        sha: child.name,
        bytes: 0,
        modifiedMs: 0,
      };
      current.bytes += directorySize(childPath);
      current.modifiedMs = Math.max(
        current.modifiedMs,
        lstatSync(childPath).mtimeMs,
      );
      entries.set(child.name, current);
    }
  }
  let total = [...entries.values()].reduce(
    (bytes, entry) => bytes + entry.bytes,
    0,
  );
  const oldestFirst = [...entries.values()].sort(
    (left, right) => left.modifiedMs - right.modifiedMs,
  );
  for (const entry of oldestFirst) {
    if (total <= maxBytes) break;
    if (protectedShas.has(entry.sha)) continue;
    for (const kind of ["targets", "cargo"]) {
      rmSync(path.join(cacheRoot, kind, entry.sha), {
        recursive: true,
        force: true,
      });
    }
    total -= entry.bytes;
  }
}

function directorySize(directory: string): number {
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const metadata = lstatSync(entryPath);
    bytes += entry.isDirectory() ? directorySize(entryPath) : metadata.size;
  }
  return bytes;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
