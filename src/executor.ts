import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import path from "node:path";

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
  kubeconfig: string;
  testdataRoot: string;
  region: string;
}

export interface ExecutionResult {
  comparison: string;
  baseArtifact: string;
  headArtifact: string;
}

export class BenchmarkExecutor {
  constructor(
    readonly config: ExecutorConfig,
    readonly processes: ProcessRunner,
  ) {}

  async execute(job: Job): Promise<ExecutionResult> {
    validateSha(job.baseSha);
    validateSha(job.headSha);
    const outputs = loadOutputs(this.config.foundationOutputsFile);
    const mirror = path.join(this.config.stateRoot, "repository.git");
    const jobRoot = path.join(this.config.workRoot, "jobs", String(job.id));
    const baseSource = path.join(jobRoot, "base");
    const headSource = path.join(jobRoot, "head");
    mkdirSync(jobRoot, { recursive: true });

    try {
      await this.prepareMirror(mirror);
      await this.removeWorktree(mirror, headSource);
      await this.removeWorktree(mirror, baseSource);
      await this.addWorktree(mirror, baseSource, job.baseSha);
      await this.addWorktree(mirror, headSource, job.headSha);
      await this.installHarness(baseSource);
      this.resetResults(job.dataset, baseSource);
      await this.prepareDatasetLayout(job.dataset, outputs.datasetBucketName);

      const baseBinary = await this.build(
        job.baseSha,
        baseSource,
        "trusted",
        undefined,
      );
      const baseArtifact = await this.publish(
        baseBinary,
        outputs.artifactBucketName,
      );
      await this.deploy(baseSource, baseArtifact, outputs, job);
      await this.runBenchmark(baseSource, job.dataset);

      const headBinary = await this.build(
        job.headSha,
        headSource,
        "untrusted",
        job.baseSha,
      );
      const headArtifact = await this.publish(
        headBinary,
        outputs.artifactBucketName,
      );
      await this.deploy(baseSource, headArtifact, outputs, job);
      const comparison = await this.runBenchmark(baseSource, job.dataset);

      return { comparison, baseArtifact, headArtifact };
    } finally {
      await this.cleanupDeployment(outputs, job.id);
      await this.removeWorktree(mirror, headSource);
      await this.removeWorktree(mirror, baseSource);
      rmSync(jobRoot, { recursive: true, force: true });
      pruneBuildCache(
        this.config.buildCacheRoot,
        this.config.buildCacheMaxBytes,
        new Set([`trusted-${job.baseSha}`, `untrusted-${job.headSha}`]),
      );
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
    await this.processes.run(
      "git",
      ["--git-dir", mirror, "worktree", "remove", "--force", destination],
      { allowFailure: true },
    );
  }

  async installHarness(baseSource: string): Promise<void> {
    await this.processes.run("npm", ["ci", "--ignore-scripts"], {
      cwd: path.join(baseSource, "benchmarks-remote"),
      env: {
        ...process.env,
        npm_config_cache: path.join(this.config.stateRoot, "npm"),
      },
    });
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

    const queries = path.join(
      baseSource,
      "testdata",
      dataset.split("/")[0]!,
      "queries",
    );
    if (!existsSync(queries)) {
      throw new Error(`Trusted base does not contain queries for ${dataset}`);
    }
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
    const now = new Date();
    utimesSync(target, now, now);
    utimesSync(cargoHome, now, now);
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
    baseSource: string,
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
        path.join(baseSource, "benchmarks-remote", "k8s", "datafusion"),
        "--namespace",
        "benchmark-datafusion",
        "--kube-context",
        outputs.clusterName,
        "--values",
        path.join(
          baseSource,
          "benchmarks-remote",
          "k8s",
          "worker-resources.yaml",
        ),
        "--set-string",
        `worker.artifact=${artifact}`,
        "--set-string",
        `worker.datasetBucket=${outputs.datasetBucketName}`,
        "--set-string",
        `worker.replicas=${job.benchmarkNodeCount}`,
        "--set-string",
        `worker.instanceType=${job.benchmarkInstanceType}`,
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

  async runBenchmark(baseSource: string, dataset: string): Promise<string> {
    const result = await this.processes.run(
      "npm",
      ["run", "datafusion-bench", "--", "--dataset", dataset],
      {
        cwd: path.join(baseSource, "benchmarks-remote"),
        env: {
          ...process.env,
          AWS_REGION: this.config.region,
          BENCHMARK_TESTDATA_ROOT: this.config.testdataRoot,
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
