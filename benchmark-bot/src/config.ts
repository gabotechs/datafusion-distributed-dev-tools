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
      sourceRoot:
        process.env.DATAFUSION_SOURCE_ROOT ??
        path.resolve(process.cwd(), "../datafusion-distributed"),
      foundationOutputsFile:
        process.env.FOUNDATION_OUTPUTS_FILE ?? ".data/foundation-outputs.json",
      harnessRoot:
        process.env.BENCHMARK_HARNESS_ROOT ??
        path.resolve(process.cwd(), "benchmarks-remote"),
      kubeconfig: process.env.KUBECONFIG ?? ".data/kubeconfig",
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
