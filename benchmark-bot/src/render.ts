import type { Job } from "./database.js";
import type {
  BenchmarkTiming,
  ExecutionProgress,
  ExecutionTimings,
} from "./executor.js";

const GITHUB_COMMENT_LIMIT = 65_536;
const TRUNCATION_NOTICE = "... earlier output truncated\n";

export function renderQueued(job: Job): string {
  return `${requestLink(job)}\n\nBenchmark job ${job.id} queued for ${formatDatasets(job.datasets)} on ${capacity(job)}, comparing base \`${shortSha(job.baseSha)}\` with head \`${shortSha(job.headSha)}\`.`;
}

export function renderRunning(job: Job): string {
  return `${requestLink(job)}\n\nRunning ${formatDatasets(job.datasets)} on ${capacity(job)}: base \`${shortSha(job.baseSha)}\`, head \`${shortSha(job.headSha)}\`.`;
}

export function renderProgress(job: Job, progress: ExecutionProgress): string {
  return `${renderRunning(job)}\n\n**Progress ${progress.step}/${progress.totalSteps}:** ${progress.message}.`;
}

export function renderFailure(job: Job): string {
  return `${requestLink(job)}\n\nBenchmark job ${job.id} failed for ${formatDatasets(job.datasets)} while comparing base \`${shortSha(job.baseSha)}\` with head \`${shortSha(job.headSha)}\`. Full details are available in the controller journal.`;
}

export function renderResult(
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

  const metadata = `${requestLink(job)}

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

`;
  if (metadata.length >= GITHUB_COMMENT_LIMIT) {
    return truncate(metadata, GITHUB_COMMENT_LIMIT);
  }
  return `${metadata}${renderComparison(
    comparison,
    GITHUB_COMMENT_LIMIT - metadata.length,
  )}`;
}

function renderComparison(comparison: string, maxLength: number): string {
  const blocks = comparison
    .trim()
    .split(/(?=^=== Comparing )/m)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) return "";
  const separatorsLength = Math.max(0, blocks.length - 1) * 2;
  const blockLimit = Math.floor(
    Math.max(0, maxLength - separatorsLength) / blocks.length,
  );
  return blocks
    .map((block) => renderComparisonBlock(block, blockLimit))
    .join("\n\n");
}

function renderComparisonBlock(block: string, blockLimit: number): string {
  if (blockLimit <= 0) return "";
  const lines = block.split("\n");
  let totalIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trimStart().startsWith("TOTAL:")) {
      totalIndex = index;
      break;
    }
  }
  if (!lines[0]?.startsWith("=== Comparing ") || totalIndex <= 0) {
    return renderPreformatted(block, blockLimit);
  }

  const summary = `${lines[0]}\n${lines[totalIndex]!.trimStart()}`;
  const details = lines
    .filter((_line, index) => index !== 0 && index !== totalIndex)
    .join("\n");
  const summaryPrefix = "<pre>";
  const summarySuffix = "</pre>\n\n";
  const detailsPrefix = `<details>
<summary>Show full query output</summary>

<pre>`;
  const detailsSuffix = `</pre>

</details>`;
  const framingLength =
    summaryPrefix.length +
    summarySuffix.length +
    detailsPrefix.length +
    detailsSuffix.length;
  if (framingLength >= blockLimit) return renderPreformatted(block, blockLimit);

  const contentLimit = blockLimit - framingLength;
  const escapedSummary = htmlEscape(summary);
  const summaryLimit = Math.min(escapedSummary.length, contentLimit);
  const renderedSummary = truncate(escapedSummary, summaryLimit);
  const detailsLimit = contentLimit - renderedSummary.length;
  const renderedDetails = truncate(htmlEscape(details), detailsLimit);
  return `${summaryPrefix}${renderedSummary}${summarySuffix}${detailsPrefix}${renderedDetails}${detailsSuffix}`;
}

function renderPreformatted(value: string, maxLength: number): string {
  const prefix = "<pre>";
  const suffix = "</pre>";
  if (prefix.length + suffix.length >= maxLength) {
    return truncate(htmlEscape(value), maxLength);
  }
  return `${prefix}${truncate(
    htmlEscape(value),
    maxLength - prefix.length - suffix.length,
  )}${suffix}`;
}

function requestLink(job: Job): string {
  return `Requested by [this comment](${job.pullRequestUrl}#issuecomment-${job.commentId}).`;
}

function sumBenchmarks(benchmarks: readonly BenchmarkTiming[]): number {
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

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= TRUNCATION_NOTICE.length) {
    return TRUNCATION_NOTICE.slice(0, Math.max(0, maxLength));
  }
  const retainedLength = Math.max(0, maxLength - TRUNCATION_NOTICE.length);
  return `${TRUNCATION_NOTICE}${value.slice(-retainedLength)}`;
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
