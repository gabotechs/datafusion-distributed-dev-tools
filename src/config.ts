export interface Config {
  repository: string;
  databasePath: string;
  pollIntervalMs: number;
  githubAppId: string;
  githubInstallationId: string;
  githubPrivateKey: string;
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
    databasePath: process.env.DATABASE_PATH ?? ".data/jobs.db",
    pollIntervalMs: pollIntervalSeconds * 1_000,
    githubAppId: required("GITHUB_APP_ID"),
    githubInstallationId: required("GITHUB_INSTALLATION_ID"),
    githubPrivateKey: required("GITHUB_PRIVATE_KEY").replaceAll("\\n", "\n"),
  };
}
