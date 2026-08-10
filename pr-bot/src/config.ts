export interface Config {
  repository: string;
  sourceRepositoryUrl: string;
  githubToken: string;
  databasePath: string;
  pollIntervalMs: number;
  executor: {
    stateRoot: string;
    workRoot: string;
    buildCacheRoot: string;
    buildCacheMaxBytes: number;
    foundationOutputsFile: string;
    harnessRoot: string;
    kubeconfig: string;
    testdataRoot: string;
    region: string;
  };
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
        new URL("../benchmarks-remote", import.meta.url).pathname,
      kubeconfig: process.env.KUBECONFIG ?? ".data/kubeconfig",
      testdataRoot: process.env.BENCHMARK_TESTDATA_ROOT ?? ".data/testdata",
      region: process.env.AWS_REGION ?? "us-east-1",
    },
  };
}
