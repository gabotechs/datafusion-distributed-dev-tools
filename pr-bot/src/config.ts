import path from "node:path";

import type { ExecutorConfig } from "./executor.js";

export interface Config {
  repository: string;
  sourceRepositoryUrl: string;
  githubToken: string;
  authorizedGithubLogins: ReadonlySet<string>;
  databasePath: string;
  pollIntervalMs: number;
  executor: Omit<ExecutorConfig, "repositoryUrl">;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  const pollIntervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS ?? "30");
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new Error("POLL_INTERVAL_SECONDS must be a positive number");
  }
  const buildCacheMaxGiB = Number(process.env.BUILD_CACHE_MAX_GIB ?? "400");
  if (!Number.isFinite(buildCacheMaxGiB) || buildCacheMaxGiB <= 0) {
    throw new Error("BUILD_CACHE_MAX_GIB must be a positive number");
  }
  return {
    repository: required("GITHUB_REPOSITORY"),
    sourceRepositoryUrl: required("SOURCE_REPOSITORY_URL"),
    githubToken: required("GH_TOKEN"),
    authorizedGithubLogins: parseGithubLogins(
      required("AUTHORIZED_GITHUB_LOGINS"),
    ),
    databasePath: process.env.DATABASE_PATH ?? ".data/jobs.db",
    pollIntervalMs: pollIntervalSeconds * 1_000,
    executor: {
      stateRoot: process.env.STATE_ROOT ?? ".data",
      workRoot: process.env.BENCHMARK_WORK_ROOT ?? ".data/work",
      buildCacheRoot: process.env.BUILD_CACHE_ROOT ?? ".data/build-cache",
      buildCacheMaxBytes: buildCacheMaxGiB * 1024 ** 3,
      foundationOutputsFile:
        process.env.FOUNDATION_OUTPUTS_FILE ?? ".data/foundation-outputs.json",
      harnessRoot:
        process.env.BENCHMARK_HARNESS_ROOT ??
        path.resolve(process.cwd(), "benchmarks-remote"),
      kubeconfig: process.env.KUBECONFIG ?? ".data/kubeconfig",
      testdataRoot: process.env.BENCHMARK_TESTDATA_ROOT ?? ".data/testdata",
      region: process.env.AWS_REGION ?? "us-east-1",
    },
  };
}

function parseGithubLogins(value: string): ReadonlySet<string> {
  const logins = value
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  if (
    logins.length === 0 ||
    logins.some(
      (login) => !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login),
    )
  ) {
    throw new Error(
      "AUTHORIZED_GITHUB_LOGINS must be a comma-separated list of GitHub logins",
    );
  }
  return new Set(logins);
}
