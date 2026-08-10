import type { Job, JobDatabase } from "./database.js";
import type {
  ExecutionProgress,
  ExecutionTimings,
  ProgressReporter,
} from "./executor.js";
import type { GitHubApi } from "./github.js";

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

    try {
      await this.github.updateComment(
        job.repository,
        job.statusCommentId,
        `${requestLink(job)}\n\nRunning ${formatDatasets(job.datasets)} on ${capacity(job)}: base \`${shortSha(job.baseSha)}\`, head \`${shortSha(job.headSha)}\`.`,
      );
      const result = await this.executor.execute(job, async (progress) => {
        await this.updateProgress(job, progress);
      });
      await this.github.updateComment(
        job.repository,
        job.statusCommentId,
        renderResult(job, result.comparison, result.timings),
      );
      this.database.updateStatus(job.id, "completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Benchmark job ${job.id} failed`, error);
      this.database.updateStatus(job.id, "failed", message);
      await this.github.updateComment(
        job.repository,
        job.statusCommentId,
        `${requestLink(job)}\n\nBenchmark job ${job.id} failed for ${formatDatasets(job.datasets)} while comparing base \`${shortSha(job.baseSha)}\` with head \`${shortSha(job.headSha)}\`. Full details are available in the controller journal.`,
      );
    }
    return true;
  }

  async updateProgress(job: Job, progress: ExecutionProgress): Promise<void> {
    try {
      await this.github.updateComment(
        job.repository,
        job.statusCommentId!,
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

function renderProgress(job: Job, progress: ExecutionProgress): string {
  return `${requestLink(job)}

Running ${formatDatasets(job.datasets)} on ${capacity(job)}: base \`${shortSha(job.baseSha)}\`, head \`${shortSha(job.headSha)}\`.

**Progress ${progress.step}/${progress.totalSteps}:** ${progress.message}.`;
}

function renderResult(
  job: Job,
  comparison: string,
  timings: ExecutionTimings,
): string {
  const baseBenchmarkMs = sumBenchmarks(timings.baseBenchmarks);
  const headBenchmarkMs = sumBenchmarks(timings.headBenchmarks);
  const benchmarkRows = job.datasets
    .map((dataset, index) => {
      const base = timings.baseBenchmarks[index];
      const head = timings.headBenchmarks[index];
      return `| Benchmark \`${dataset}\` | ${formatDuration(base?.durationMs ?? 0)} | ${formatDuration(head?.durationMs ?? 0)} |`;
    })
    .join("\n");
  const queueMs = Math.max(
    0,
    Date.parse(job.updatedAt) - Date.parse(job.createdAt),
  );

  return `${requestLink(job)}

<details>
<summary>Run metadata</summary>

| Phase | Base | PR head |
| --- | ---: | ---: |
| Compilation | ${formatDuration(timings.baseCompileMs)} | ${formatDuration(timings.headCompileMs)} |
| Kubernetes provisioning | ${formatDuration(timings.baseDeployMs)} | ${formatDuration(timings.headDeployMs)} |
| All benchmarks | ${formatDuration(baseBenchmarkMs)} | ${formatDuration(headBenchmarkMs)} |
${benchmarkRows}

Queue: ${formatDuration(queueMs)} · Dataset validation: ${formatDuration(timings.validationMs)} · Total: ${formatDuration(timings.totalMs)}

Base: \`${shortSha(job.baseSha)}\` · PR head: \`${shortSha(job.headSha)}\` · Capacity: ${capacity(job)}

</details>

<pre>${htmlEscape(truncate(comparison.trim()))}</pre>`;
}

function requestLink(job: Job): string {
  return `Requested by [this comment](${job.pullRequestUrl}#issuecomment-${job.commentId}).`;
}

function sumBenchmarks(benchmarks: ExecutionTimings["baseBenchmarks"]): number {
  return benchmarks.reduce(
    (total, benchmark) => total + benchmark.durationMs,
    0,
  );
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${remainingSeconds}s`;
}

function capacity(job: Job): string {
  return `${job.benchmarkNodeCount} \`${job.benchmarkInstanceType}\` nodes`;
}

function formatDatasets(datasets: readonly string[]): string {
  return datasets.map((dataset) => `\`${dataset}\``).join(", ");
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
