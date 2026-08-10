export interface Config {
  repository: string;
  sourceRepositoryUrl: string;
  databasePath: string;
  pollIntervalMs: number;
  githubAppId: string;
  githubInstallationId: string;
  githubPrivateKey: string;
  executor: {
    stateRoot: string;
    builderImage: string;
    foundationOutputsFile: string;
    kubeconfig: string;
    testdataRoot: string;
    containerRuntime: string;
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
  return {
    repository: required("GITHUB_REPOSITORY"),
    sourceRepositoryUrl: required("SOURCE_REPOSITORY_URL"),
    databasePath: process.env.DATABASE_PATH ?? ".data/jobs.db",
    pollIntervalMs: pollIntervalSeconds * 1_000,
    githubAppId: required("GITHUB_APP_ID"),
    githubInstallationId: required("GITHUB_INSTALLATION_ID"),
    githubPrivateKey: required("GITHUB_PRIVATE_KEY").replaceAll("\\n", "\n"),
    executor: {
      stateRoot: process.env.STATE_ROOT ?? ".data",
      builderImage: required("BUILDER_IMAGE"),
      foundationOutputsFile:
        process.env.FOUNDATION_OUTPUTS_FILE ?? ".data/foundation-outputs.json",
      kubeconfig: process.env.KUBECONFIG ?? ".data/kubeconfig",
      testdataRoot: process.env.BENCHMARK_TESTDATA_ROOT ?? ".data/testdata",
      containerRuntime: process.env.CONTAINER_RUNTIME ?? "podman",
      region: process.env.AWS_REGION ?? "us-east-1",
    },
  };
}
