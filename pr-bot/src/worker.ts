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
    if (job.statusCommentId === null) {
      throw new Error(`Benchmark job ${job.id} has no GitHub status comment`);
    }

    try {
      await this.github.updateComment(
        job.repository,
        job.statusCommentId,
        `Running \`${job.dataset}\` on ${capacity(job)}: base \`${shortSha(job.baseSha)}\`, head \`${shortSha(job.headSha)}\`.`,
      );
      const result = await this.executor.execute(job);
      await this.github.updateComment(
        job.repository,
        job.statusCommentId,
        renderResult(job, result.comparison),
      );
      this.database.updateStatus(job.id, "completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Benchmark job ${job.id} failed`, error);
      this.database.updateStatus(job.id, "failed", message);
      await this.github.updateComment(
        job.repository,
        job.statusCommentId,
        `Benchmark job ${job.id} failed for \`${job.dataset}\` while comparing base \`${shortSha(job.baseSha)}\` with head \`${shortSha(job.headSha)}\`. Full details are available in the controller journal.`,
      );
    }
    return true;
  }
}

function renderResult(job: Job, comparison: string): string {
  return `Benchmark completed for \`${job.dataset}\` on ${capacity(job)}.\n\nBase: \`${job.baseSha}\`\nHead: \`${job.headSha}\`\n\n<details><summary>Comparison</summary>\n\n<pre>${htmlEscape(truncate(comparison))}</pre>\n</details>`;
}

function capacity(job: Job): string {
  return `${job.benchmarkNodeCount} \`${job.benchmarkInstanceType}\` nodes`;
}

function truncate(value: string): string {
  return value.length <= 50_000
    ? value
    : `... earlier output truncated\n${value.slice(-49_900)}`;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
