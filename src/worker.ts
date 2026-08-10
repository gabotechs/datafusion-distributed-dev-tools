import type { Job, JobDatabase } from "./database.js";
import type { GitHubApi } from "./github.js";

export interface JobExecutor {
  execute(job: Job): Promise<{ comparison: string }>;
}

export class JobWorker {
  constructor(
    readonly database: JobDatabase,
    readonly github: GitHubApi,
    readonly executor: JobExecutor,
  ) {}

  async runOnce(): Promise<boolean> {
    const job = this.database.claimNextPending();
    if (!job) return false;

    try {
      await this.github.postComment(
        job.repository,
        job.pullRequestNumber,
        `Running \`${job.dataset}\`: base \`${shortSha(job.baseSha)}\`, head \`${shortSha(job.headSha)}\`.`,
      );
      const result = await this.executor.execute(job);
      await this.github.postComment(
        job.repository,
        job.pullRequestNumber,
        renderResult(job, result.comparison),
      );
      this.database.updateStatus(job.id, "completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.updateStatus(job.id, "failed", message);
      await this.github.postComment(
        job.repository,
        job.pullRequestNumber,
        `Benchmark failed for \`${job.dataset}\` comparing base \`${shortSha(job.baseSha)}\` with head \`${shortSha(job.headSha)}\`.\n\n\`\`\`text\n${truncate(message)}\n\`\`\``,
      );
    }
    return true;
  }
}

function renderResult(job: Job, comparison: string): string {
  return `Benchmark completed for \`${job.dataset}\`.\n\nBase: \`${job.baseSha}\`\nHead: \`${job.headSha}\`\n\n\`\`\`text\n${truncate(comparison)}\n\`\`\``;
}

function truncate(value: string): string {
  const sanitized = value.replaceAll("```", "` ` `");
  return sanitized.length <= 50_000
    ? sanitized
    : `... earlier output truncated\n${sanitized.slice(-49_900)}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
