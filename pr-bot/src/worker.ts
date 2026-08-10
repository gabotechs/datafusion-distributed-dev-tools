import type { Job, JobDatabase } from "./database.js";
import type {
  ExecutionProgress,
  ExecutionTimings,
  ProgressReporter,
} from "./executor.js";
import type { GitHubApi } from "./github.js";
import {
  renderFailure,
  renderProgress,
  renderResult,
  renderRunning,
} from "./render.js";

export interface JobExecutor {
  execute(
    job: Job,
    onProgress?: ProgressReporter,
  ): Promise<{
    comparison: string;
    timings: ExecutionTimings;
  }>;
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
    const statusCommentId = job.statusCommentId;

    try {
      await this.github.updateComment(
        job.repository,
        statusCommentId,
        renderRunning(job),
      );
      const result = await this.executor.execute(job, async (progress) => {
        await this.updateProgress(job, statusCommentId, progress);
      });
      await this.github.updateComment(
        job.repository,
        statusCommentId,
        renderResult(job, result.comparison, result.timings),
      );
      this.database.updateStatus(job.id, "completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Benchmark job ${job.id} failed`, error);
      this.database.updateStatus(job.id, "failed", message);
      await this.github.updateComment(
        job.repository,
        statusCommentId,
        renderFailure(job),
      );
    }
    return true;
  }

  async updateProgress(
    job: Job,
    statusCommentId: number,
    progress: ExecutionProgress,
  ): Promise<void> {
    try {
      await this.github.updateComment(
        job.repository,
        statusCommentId,
        renderProgress(job, progress),
      );
    } catch (error) {
      console.error(
        `Could not update progress for benchmark job ${job.id}`,
        error,
      );
    }
  }
}
