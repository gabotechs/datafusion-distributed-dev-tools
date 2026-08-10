import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import type { Job } from "./database.js";
import type { ProcessRunner } from "./process.js";

interface FoundationOutputs {
  clusterName: string;
  datasetBucketName: string;
  artifactBucketName: string;
  benchmarkInstanceType: string;
  benchmarkNodeCount: number;
}

export interface ExecutorConfig {
  repositoryUrl: string;
  stateRoot: string;
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
    const outputs = loadOutputs(this.config.foundationOutputsFile);
    const mirror = path.join(this.config.stateRoot, "repository.git");
    const jobRoot = path.join(this.config.stateRoot, "jobs", String(job.id));
    const baseSource = path.join(jobRoot, "base");
    const headSource = path.join(jobRoot, "head");
    mkdirSync(jobRoot, { recursive: true });

    await this.prepareMirror(mirror);
    await this.removeWorktree(mirror, headSource);
    await this.removeWorktree(mirror, baseSource);
    await this.addWorktree(mirror, baseSource, job.baseSha);
    await this.addWorktree(mirror, headSource, job.headSha);

    try {
      await this.installHarness(baseSource);
      this.resetResults(job.dataset, baseSource);
      await this.prepareDatasetLayout(job.dataset, outputs.datasetBucketName);

      const baseBinary = await this.build(job.baseSha, baseSource, undefined);
      const baseArtifact = await this.publish(
        baseBinary,
        outputs.artifactBucketName,
      );
      await this.deploy(baseSource, baseArtifact, outputs);
      await this.runBenchmark(baseSource, job.dataset);

      const headBinary = await this.build(job.headSha, headSource, job.baseSha);
      const headArtifact = await this.publish(
        headBinary,
        outputs.artifactBucketName,
      );
      await this.deploy(baseSource, headArtifact, outputs);
      const comparison = await this.runBenchmark(baseSource, job.dataset);

      return { comparison, baseArtifact, headArtifact };
    } finally {
      await this.removeWorktree(mirror, headSource);
      await this.removeWorktree(mirror, baseSource);
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
    await this.processes.run("git", [
      "--git-dir",
      mirror,
      "worktree",
      "add",
      "--detach",
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
    seedSha: string | undefined,
  ): Promise<string> {
    const cacheRoot = path.join(this.config.stateRoot, "build-cache");
    const target = path.join(cacheRoot, "targets", sha);
    const cargoHome = path.join(cacheRoot, "cargo", sha);
    const seedTarget = seedSha ? path.join(cacheRoot, "targets", seedSha) : "";
    const seedCargoHome = seedSha ? path.join(cacheRoot, "cargo", seedSha) : "";
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
    const key = `.benchmark-artifacts/pr-bot/workers/datafusion/${digest}/worker`;
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
  ): Promise<void> {
    await this.processes.run(
      "helm",
      [
        "upgrade",
        "--install",
        "datafusion",
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
        `worker.replicas=${outputs.benchmarkNodeCount}`,
        "--set-string",
        `worker.instanceType=${outputs.benchmarkInstanceType}`,
        "--rollback-on-failure",
        "--cleanup-on-fail",
        "--wait",
        "--timeout",
        "25m",
      ],
      { env: { ...process.env, KUBECONFIG: this.config.kubeconfig } },
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
    !value.artifactBucketName ||
    !value.benchmarkInstanceType ||
    !Number.isInteger(value.benchmarkNodeCount)
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

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
