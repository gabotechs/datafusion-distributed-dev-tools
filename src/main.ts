import { loadConfig } from "./config.js";
import { JobDatabase } from "./database.js";
import { BenchmarkExecutor } from "./executor.js";
import { GitHubClient } from "./github.js";
import { waitForNextPoll } from "./poll-wait.js";
import { CommentPoller } from "./poller.js";
import { LocalProcessRunner } from "./process.js";
import { JobWorker } from "./worker.js";

const config = loadConfig();
process.umask(0o077);
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

try {
  await executor.cleanup();
} catch (error) {
  console.error("Failed to remove a stale benchmark deployment", error);
}

const recovery = database.recoverRunningJobs();
if (recovery.retried > 0) {
  console.log(`Recovered ${recovery.retried} interrupted benchmark job(s)`);
}
for (const job of recovery.failed) {
  try {
    await github.postComment(
      job.repository,
      job.pullRequestNumber,
      `Benchmark job ${job.id} failed after three controller restarts. Full details are available in the controller journal.`,
    );
  } catch (error) {
    console.error(
      `Failed to report terminal recovery for job ${job.id}`,
      error,
    );
  }
}

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown.abort();
  });
}

while (!shutdown.signal.aborted) {
  try {
    await poller.poll();
  } catch (error) {
    console.error("GitHub comment poll failed", error);
  }
  try {
    while (!shutdown.signal.aborted && (await worker.runOnce())) {
      // Drain the serialized queue before waiting for the next poll.
    }
  } catch (error) {
    console.error("Benchmark queue processing failed", error);
  }
  if (!shutdown.signal.aborted) {
    await waitForNextPoll(config.pollIntervalMs, shutdown.signal);
  }
}
database.close();
