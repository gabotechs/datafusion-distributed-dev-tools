import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Job } from "./database.js";
import type { ProcessRunner } from "./process.js";

interface FoundationOutputs {
  clusterName: string;
  datasetBucketName: string;
  artifactBucketName: string;
}

const DEPLOYMENT_NAME = "datafusion-benchmark-bot";
export const BENCHMARK_ITERATIONS = 5;
export const BENCHMARK_WARMUP = true;

export interface ExecutorConfig {
  repositoryUrl: string;
  sourceRoot: string;
  foundationOutputsFile: string;
  harnessRoot: string;
  kubeconfig: string;
  region: string;
}

export interface ExecutionResult {
  comparison: string;
  timings: ExecutionTimings;
}

export interface BenchmarkTiming {
  dataset: string;
  durationMs: number;
}

export interface ExecutionTimings {
  validationMs: number;
  baseDeployMs: number;
  baseBenchmarks: BenchmarkTiming[];
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
  baseCheckout: string;
  validation: string;
  baseDeploy: string;
  baseBenchmarks: readonly string[];
  headCheckout: string;
  headDeploy: string;
  headBenchmarks: readonly string[];
  cleanup: string;
  all: readonly string[];
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
          timings: Omit<ExecutionTimings, "totalMs">;
        }
      | undefined;
    let totalMs = 0;

    try {
      await reportProgress(progressPlan.baseCheckout);
      await this.checkoutRevision(job.baseSha);

      await reportProgress(progressPlan.validation);
      const validationMs = await this.validateDatasets(
        job.datasets,
        outputs.datasetBucketName,
      );

      await reportProgress(progressPlan.baseDeploy);
      const baseDeployMs = await this.deployTimed(outputs, job);
      const baseBenchmarks = await this.benchmarkDatasets(
        job.datasets,
        progressPlan.baseBenchmarks,
        reportProgress,
        "datafusion-benchmark-base",
      );

      await reportProgress(progressPlan.headCheckout);
      await this.checkoutRevision(job.headSha);

      await reportProgress(progressPlan.headDeploy);
      const headDeployMs = await this.deployTimed(outputs, job);
      const head = await this.benchmarkHeadDatasets(
        job.datasets,
        progressPlan.headBenchmarks,
        reportProgress,
      );

      completed = {
        comparison: head.comparison,
        timings: {
          validationMs,
          baseDeployMs,
          baseBenchmarks,
          headDeployMs,
          headBenchmarks: head.timings,
        },
      };
    } finally {
      await reportProgress(progressPlan.cleanup);
      await this.cleanupDeployment(outputs);
      totalMs = performance.now() - executionStarted;
    }

    if (!completed) throw new Error("Benchmark execution did not complete");
    return {
      comparison: completed.comparison,
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

  private async deployTimed(
    outputs: FoundationOutputs,
    job: Job,
  ): Promise<number> {
    const started = performance.now();
    await this.deploy(outputs, job);
    return performance.now() - started;
  }

  private async benchmarkDatasets(
    datasets: readonly string[],
    progressMessages: readonly string[],
    reportProgress: (message: string) => Promise<void>,
    resultName: string,
  ): Promise<BenchmarkTiming[]> {
    const timings: BenchmarkTiming[] = [];
    for (const [index, dataset] of datasets.entries()) {
      await reportProgress(progressMessages[index]!);
      const started = performance.now();
      await this.runBenchmark(dataset, resultName);
      timings.push({ dataset, durationMs: performance.now() - started });
    }
    return timings;
  }

  private async benchmarkHeadDatasets(
    datasets: readonly string[],
    progressMessages: readonly string[],
    reportProgress: (message: string) => Promise<void>,
  ): Promise<HeadBenchmarkResult> {
    const timings: BenchmarkTiming[] = [];
    const comparisons: string[] = [];
    for (const [index, dataset] of datasets.entries()) {
      await reportProgress(progressMessages[index]!);
      const started = performance.now();
      await this.runBenchmark(dataset, "datafusion-benchmark-head");
      timings.push({ dataset, durationMs: performance.now() - started });
      comparisons.push(
        await this.compareResults(
          dataset,
          "datafusion-benchmark-base",
          "datafusion-benchmark-head",
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

  async cleanup(): Promise<void> {
    await this.cleanupDeployment(
      loadOutputs(this.config.foundationOutputsFile),
    );
  }

  async checkoutRevision(sha: string): Promise<void> {
    validateSha(sha);
    await this.processes.run("git", [
      "-C",
      this.config.sourceRoot,
      "remote",
      "set-url",
      "origin",
      this.config.repositoryUrl,
    ]);
    await this.processes.run("git", [
      "-C",
      this.config.sourceRoot,
      "fetch",
      "--force",
      "--no-tags",
      "origin",
      sha,
    ]);
    await this.processes.run("git", [
      "-C",
      this.config.sourceRoot,
      "checkout",
      "--detach",
      "--force",
      sha,
    ]);
  }

  async prepareDatasetLayout(dataset: string, bucket: string): Promise<void> {
    const datasetDirectory = safeDatasetPath(this.testdataRoot(), dataset);
    rmSync(datasetDirectory, { recursive: true, force: true });
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

  async deploy(outputs: FoundationOutputs, job: Job): Promise<void> {
    await this.processes.run("npm", ["run", "datafusion-deploy"], {
      cwd: this.config.harnessRoot,
      env: this.deploymentEnvironment(outputs, job),
    });
  }

  async cleanupDeployment(outputs: FoundationOutputs): Promise<void> {
    await this.processes.run("npm", ["run", "datafusion-destroy"], {
      allowFailure: true,
      cwd: this.config.harnessRoot,
      env: this.deploymentEnvironment(outputs),
    });
  }

  async runBenchmark(dataset: string, resultName: string): Promise<void> {
    const outputs = loadOutputs(this.config.foundationOutputsFile);
    await this.processes.run(
      "node",
      [
        path.join(this.config.harnessRoot, "dist", "datafusion-bench.cjs"),
        dataset,
        "--bucket",
        `s3://${outputs.datasetBucketName}`,
        "--k8s-cluster",
        outputs.clusterName,
        "--iterations",
        String(BENCHMARK_ITERATIONS),
        "--warmup",
        String(BENCHMARK_WARMUP),
        "--result-name",
        resultName,
        "--kubeconfig",
        this.config.kubeconfig,
        "--no-compare",
        "--region",
        this.config.region,
        "--k8s-service",
        DEPLOYMENT_NAME,
        "--testdata-root",
        this.testdataRoot(),
      ],
      { cwd: this.config.harnessRoot },
    );
  }

  async compareResults(
    dataset: string,
    baseResultName: string,
    headResultName: string,
  ): Promise<string> {
    const result = await this.processes.run(
      "node",
      [
        path.join(this.config.harnessRoot, "dist", "compare.cjs"),
        dataset,
        "--testdata-root",
        this.testdataRoot(),
        baseResultName,
        headResultName,
      ],
      { cwd: this.config.harnessRoot, quiet: true },
    );
    return result.stdout;
  }

  private deploymentEnvironment(
    outputs: FoundationOutputs,
    job?: Job,
  ): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      AWS_REGION: this.config.region,
      CARGO_TARGET_DIR: "/var/cache/datafusion-pr-build/target",
      DATAFUSION_BUILD_WRAPPER: "/usr/local/sbin/datafusion-pr-build",
      DEPLOYMENT_NAME,
      KUBECONFIG: this.config.kubeconfig,
      PULUMI_OUTPUTS_FILE: this.config.foundationOutputsFile,
      WORKER_ARTIFACT_BUCKET: outputs.artifactBucketName,
      WORKER_ARTIFACT_PREFIX: "workers/datafusion",
    };
    if (job) {
      environment.BENCHMARK_INSTANCE_TYPE = job.benchmarkInstanceType;
      environment.NODE_COUNT = String(job.benchmarkNodeCount);
    }
    return environment;
  }

  private testdataRoot(): string {
    return path.join(this.config.sourceRoot, "testdata");
  }
}

function createProgressPlan(datasets: readonly string[]): ProgressPlan {
  const baseCheckout = "Checking out the base revision";
  const validation = "Validating all requested datasets";
  const baseDeploy = "Deploying the base revision";
  const baseBenchmarks = datasets.map(
    (dataset) => `Benchmarking base: ${dataset}`,
  );
  const headCheckout = "Checking out the PR-head revision";
  const headDeploy = "Deploying the PR-head revision";
  const headBenchmarks = datasets.map(
    (dataset) => `Benchmarking PR head: ${dataset}`,
  );
  const cleanup = "Destroying the benchmark deployment";
  return {
    baseCheckout,
    validation,
    baseDeploy,
    baseBenchmarks,
    headCheckout,
    headDeploy,
    headBenchmarks,
    cleanup,
    all: [
      baseCheckout,
      validation,
      baseDeploy,
      ...baseBenchmarks,
      headCheckout,
      headDeploy,
      ...headBenchmarks,
      cleanup,
    ],
  };
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
