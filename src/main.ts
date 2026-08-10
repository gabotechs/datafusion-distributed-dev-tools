import { loadConfig } from "./config.js";
import { JobDatabase } from "./database.js";
import { GitHubClient } from "./github.js";
import { CommentPoller } from "./poller.js";

const config = loadConfig();
const database = new JobDatabase(config.databasePath);
const github = new GitHubClient(
  config.githubAppId,
  config.githubInstallationId,
  config.githubPrivateKey,
);
const poller = new CommentPoller(config.repository, database, github);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

while (!stopping) {
  try {
    await poller.poll();
  } catch (error) {
    console.error(error);
  }
  if (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
database.close();
