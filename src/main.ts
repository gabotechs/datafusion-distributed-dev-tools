import { loadConfig } from "./config.js";
import { JobDatabase } from "./database.js";
import { BenchmarkExecutor } from "./executor.js";
import { GitHubClient } from "./github.js";
import { CommentPoller } from "./poller.js";
import { LocalProcessRunner } from "./process.js";
import { JobWorker } from "./worker.js";

const config = loadConfig();
const database = new JobDatabase(config.databasePath);
const processes = new LocalProcessRunner();
const github = new GitHubClient(config.githubToken);
const poller = new CommentPoller(config.repository, database, github);
const executor = new BenchmarkExecutor(
  {
    repositoryUrl: config.sourceRepositoryUrl,
    ...config.executor,
  },
  processes,
);
const worker = new JobWorker(database, github, executor);

const recovered = database.recoverRunningJobs();
if (recovered > 0) {
  console.log(`Recovered ${recovered} interrupted benchmark job(s)`);
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

while (!stopping) {
  try {
    await poller.poll();
    while (!stopping && (await worker.runOnce())) {
      // Drain the serialized queue before waiting for the next poll.
    }
  } catch (error) {
    console.error(error);
  }
  if (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
database.close();
