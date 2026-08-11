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
  writeFileSync,
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

const HELM_DEPLOY_TIMEOUT = "25m";
const HELM_CLEANUP_TIMEOUT = "10m";
const CARGO_BUILD_OUTPUT_TAIL_BYTES = 128 * 1024;

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

interface ProgressPlan {
  validation: string;
  sources: string;
  baseCompile: string;
  parallelPreparation: string;
  baseBenchmarks: readonly string[];
  headDeploy: string;
  headBenchmarks: readonly string[];
  cleanup: string;
  all: readonly string[];
}

interface CompiledArtifact {
  artifact: string;
  compileMs: number;
}

interface PreparedRevisions {
  headArtifact: string;
  baseDeployMs: number;
  headCompileMs: number;
}

interface HeadBenchmarkResult {
  timings: BenchmarkTiming[];
  comparison: string;
}

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
    const progressPlan = createProgressPlan(job.datasets);
    let progressStep = 0;
    const reportProgress = async (message: string): Promise<void> => {
      await onProgress({
        step: ++progressStep,
        totalSteps: progressPlan.all.length,
        message,
      });
    };
    let completed:
      | {
          comparison: string;
          baseArtifact: string;
          headArtifact: string;
          timings: Omit<ExecutionTimings, "totalMs">;
        }
      | undefined;
    let totalMs = 0;
    mkdirSync(jobRoot, { recursive: true });

    try {
      await reportProgress(progressPlan.validation);
      const validationMs = await this.validateDatasets(
        job.datasets,
        outputs.datasetBucketName,
      );

      await reportProgress(progressPlan.sources);
      await this.prepareSources(job, mirror, jobRoot, baseSource, headSource);

      await reportProgress(progressPlan.baseCompile);
      const base = await this.compileAndPublish(
        job.baseSha,
        baseSource,
        "trusted",
        undefined,
        outputs.artifactBucketName,
      );
      deploymentStarted = true;

      await reportProgress(progressPlan.parallelPreparation);
      const prepared = await this.prepareRevisions(
        job,
        outputs,
        base.artifact,
        headSource,
      );

      const baseBenchmarks = await this.benchmarkDatasets(
        job.datasets,
        progressPlan.baseBenchmarks,
        reportProgress,
        job.id,
        engineName(job.baseSha),
      );

      await reportProgress(progressPlan.headDeploy);
      const headDeployMs = await this.deployTimed(
        prepared.headArtifact,
        outputs,
        job,
      );

      const head = await this.benchmarkHeadDatasets(
        job,
        progressPlan.headBenchmarks,
        reportProgress,
        jobRoot,
      );

      completed = {
        comparison: head.comparison,
        baseArtifact: base.artifact,
        headArtifact: prepared.headArtifact,
        timings: {
          validationMs,
          baseCompileMs: base.compileMs,
          baseDeployMs: prepared.baseDeployMs,
          baseBenchmarks,
          headCompileMs: prepared.headCompileMs,
          headDeployMs,
          headBenchmarks: head.timings,
        },
      };
    } finally {
      await reportProgress(progressPlan.cleanup);
      await this.cleanupJob(
        job,
        outputs,
        mirror,
        jobRoot,
        baseSource,
        headSource,
        deploymentStarted,
      );
      totalMs = performance.now() - executionStarted;
    }

    if (!completed) throw new Error("Benchmark execution did not complete");
    return {
      comparison: completed.comparison,
      baseArtifact: completed.baseArtifact,
      headArtifact: completed.headArtifact,
      timings: { ...completed.timings, totalMs },
    };
  }

  private async validateDatasets(
    datasets: readonly string[],
    bucket: string,
  ): Promise<number> {
    const started = performance.now();
    for (const dataset of datasets) {
      await this.prepareDatasetLayout(dataset, bucket);
    }
    return performance.now() - started;
  }

  private async prepareSources(
    job: Job,
    mirror: string,
    jobRoot: string,
    baseSource: string,
    headSource: string,
  ): Promise<void> {
    await this.prepareMirror(mirror);
    await this.removeWorktree(mirror, headSource);
    await this.removeWorktree(mirror, baseSource);
    await this.addWorktree(mirror, baseSource, job.baseSha);
    await this.addWorktree(mirror, headSource, job.headSha);
    this.prepareWorker(baseSource);
    this.prepareWorker(headSource);
    await this.prepareSourcePermissions(jobRoot);
    for (const dataset of job.datasets) this.resetResults(dataset, baseSource);
  }

  private async compileAndPublish(
    sha: string,
    source: string,
    trust: "trusted" | "untrusted",
    seedSha: string | undefined,
    artifactBucket: string,
  ): Promise<CompiledArtifact> {
    const started = performance.now();
    const binary = await this.build(sha, source, trust, seedSha);
    const compileMs = performance.now() - started;
    return {
      artifact: await this.publish(binary, artifactBucket),
      compileMs,
    };
  }

  private async prepareRevisions(
    job: Job,
    outputs: FoundationOutputs,
    baseArtifact: string,
    headSource: string,
  ): Promise<PreparedRevisions> {
    const headArtifactPromise = this.compileAndPublish(
      job.headSha,
      headSource,
      "untrusted",
      job.baseSha,
      outputs.artifactBucketName,
    );
    const baseDeploymentPromise = this.deployTimed(baseArtifact, outputs, job);
    const [headArtifactResult, baseDeploymentResult] = await Promise.allSettled(
      [headArtifactPromise, baseDeploymentPromise] as const,
    );

    // Deployment failures take precedence because the base benchmark cannot run.
    if (baseDeploymentResult.status === "rejected") {
      throw baseDeploymentResult.reason;
    }
    if (headArtifactResult.status === "rejected") {
      throw headArtifactResult.reason;
    }
    return {
      headArtifact: headArtifactResult.value.artifact,
      headCompileMs: headArtifactResult.value.compileMs,
      baseDeployMs: baseDeploymentResult.value,
    };
  }

  private async deployTimed(
    artifact: string,
    outputs: FoundationOutputs,
    job: Job,
  ): Promise<number> {
    const started = performance.now();
    await this.deploy(artifact, outputs, job);
    return performance.now() - started;
  }

  private async benchmarkDatasets(
    datasets: readonly string[],
    progressMessages: readonly string[],
    reportProgress: (message: string) => Promise<void>,
    jobId: number,
    engine: string,
  ): Promise<BenchmarkTiming[]> {
    const timings: BenchmarkTiming[] = [];
    for (const [index, dataset] of datasets.entries()) {
      await reportProgress(progressMessages[index]!);
      const started = performance.now();
      await this.runBenchmark(dataset, jobId, engine);
      timings.push({ dataset, durationMs: performance.now() - started });
    }
    return timings;
  }

  private async benchmarkHeadDatasets(
    job: Job,
    progressMessages: readonly string[],
    reportProgress: (message: string) => Promise<void>,
    jobRoot: string,
  ): Promise<HeadBenchmarkResult> {
    const timings: BenchmarkTiming[] = [];
    const comparisons: string[] = [];
    for (const [index, dataset] of job.datasets.entries()) {
      await reportProgress(progressMessages[index]!);
      const started = performance.now();
      await this.runBenchmark(dataset, job.id, engineName(job.headSha));
      timings.push({ dataset, durationMs: performance.now() - started });
      comparisons.push(
        await this.compareResults(
          dataset,
          engineName(job.baseSha),
          engineName(job.headSha),
          path.join(
            jobRoot,
            "comparisons",
            `${dataset.replaceAll("/", "-")}.txt`,
          ),
        ),
      );
    }
    return {
      timings,
      comparison: comparisons
        .map((value) => value.trim())
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  private async cleanupJob(
    job: Job,
    outputs: FoundationOutputs,
    mirror: string,
    jobRoot: string,
    baseSource: string,
    headSource: string,
    deploymentStarted: boolean,
  ): Promise<void> {
    if (deploymentStarted) await this.cleanupDeployment(outputs, job.id);
    await this.removeWorktree(mirror, headSource);
    await this.removeWorktree(mirror, baseSource);
    rmSync(jobRoot, { recursive: true, force: true });
    pruneBuildCache(
      this.config.buildCacheRoot,
      this.config.buildCacheMaxBytes,
      new Set([`trusted-${job.baseSha}`, `untrusted-${job.headSha}`]),
    );
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
      const tableDirectory = path.join(datasetDirectory, table);
      mkdirSync(tableDirectory, { recursive: true });
      writeFileSync(path.join(tableDirectory, ".remote-layout.parquet"), "");
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
    await this.processes.run(
      "sudo",
      ["/usr/local/sbin/datafusion-pr-cargo-build", source, target, cargoHome],
      { outputTailBytes: CARGO_BUILD_OUTPUT_TAIL_BYTES },
    );

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
        HELM_DEPLOY_TIMEOUT,
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
        HELM_CLEANUP_TIMEOUT,
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
    engine: string,
  ): Promise<void> {
    const outputs = loadOutputs(this.config.foundationOutputsFile);
    await this.processes.run(
      "node",
      [
        path.join(this.config.harnessRoot, "dist", "datafusion-bench.cjs"),
        "--bucket",
        `s3://${outputs.datasetBucketName}`,
        "--cluster-name",
        outputs.clusterName,
        "--dataset",
        dataset,
        "--deployment",
        "datafusion",
        "--engine",
        engine,
        "--kubeconfig",
        this.config.kubeconfig,
        "--no-compare",
        "--region",
        this.config.region,
        "--service",
        deploymentName(jobId),
        "--testdata-root",
        this.config.testdataRoot,
      ],
      {
        cwd: this.config.harnessRoot,
      },
    );
  }

  async compareResults(
    dataset: string,
    baseEngine: string,
    headEngine: string,
    output: string,
  ): Promise<string> {
    await this.processes.run(
      "node",
      [
        path.join(this.config.harnessRoot, "dist", "compare.cjs"),
        "--dataset",
        dataset,
        "--output",
        output,
        "--testdata-root",
        this.config.testdataRoot,
        baseEngine,
        headEngine,
      ],
      {
        cwd: this.config.harnessRoot,
      },
    );
    return readFileSync(output, "utf8");
  }
}

function createProgressPlan(datasets: readonly string[]): ProgressPlan {
  const validation = "Validating all requested datasets";
  const sources = "Preparing immutable base and PR source checkouts";
  const baseCompile = "Compiling the base revision";
  const parallelPreparation =
    "Provisioning the base Kubernetes deployment and compiling the PR head";
  const baseBenchmarks = datasets.map(
    (dataset) => `Benchmarking base: ${dataset}`,
  );
  const headDeploy = "Provisioning the PR-head Kubernetes deployment";
  const headBenchmarks = datasets.map(
    (dataset) => `Benchmarking PR head: ${dataset}`,
  );
  const cleanup = "Cleaning up the isolated deployment and worktrees";
  return {
    validation,
    sources,
    baseCompile,
    parallelPreparation,
    baseBenchmarks,
    headDeploy,
    headBenchmarks,
    cleanup,
    all: [
      validation,
      sources,
      baseCompile,
      parallelPreparation,
      ...baseBenchmarks,
      headDeploy,
      ...headBenchmarks,
      cleanup,
    ],
  };
}

function engineName(sha: string): string {
  validateSha(sha);
  return `datafusion-distributed-${sha.slice(0, 12)}`;
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
