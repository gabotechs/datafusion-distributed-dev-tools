import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { errorMessage, isNotFoundError } from "./filesystem";
import { datasetPath } from "./paths";
import { compareQueryIds } from "./query-order";

export const RESULTS_DIR = ".results-remote";
export const PREVIOUS_RUN_FILE = "previous-run.json";
export const RUN_MANIFEST_DIR = ".run";
export const RUN_MANIFEST_FILE = "manifest.json";
const QUERY_HIGHLIGHT_THRESHOLD = 1.5;
const TOTAL_HIGHLIGHT_THRESHOLD = 1.1;

export interface QueryIter {
  plan: string;
  rowCount: number;
  elapsed: number;
  tasks: number;
  statsQErrorP50?: number;
  statsQErrorP95?: number;
  error?: string;
}

const queryIterationSchema = z.object({
  rowCount: z.number(),
  elapsed: z.number(),
  error: z.string().optional(),
  plan: z.string(),
  tasks: z.number().default(0),
  statsQErrorP50: z.number().optional(),
  statsQErrorP95: z.number().optional(),
});

const benchResultSchema = z.object({
  dataset: z.string(),
  // Preserve the version 1 on-disk key for existing benchmark results.
  engine: z.string(),
  id: z.string(),
  iterations: z.array(queryIterationSchema),
});

const queryIdSchema = z
  .string()
  .min(1)
  .refine(
    (queryId) =>
      path.basename(queryId) === queryId && ![".", ".."].includes(queryId),
    "query IDs must be file names",
  );
export const runManifestSchema = z
  .object({
    version: z.literal(1),
    startTime: z.number().int().nonnegative(),
    dataset: z.string(),
    // Preserve the version 1 on-disk key for existing benchmark results.
    engine: z.string(),
    queryIds: z
      .array(queryIdSchema)
      .refine(
        (queryIds) => new Set(queryIds).size === queryIds.length,
        "queryIds must be unique",
      ),
  })
  .strict();

export type RunManifest = z.infer<typeof runManifestSchema>;

function resultFilePath(
  dataset: string,
  resultName: string,
  id: string,
  testdataRoot?: string,
): string {
  return path.join(
    datasetPath(dataset, testdataRoot),
    RESULTS_DIR,
    resultName,
    `${id}.json`,
  );
}

function runManifestPath(
  dataset: string,
  resultName: string,
  testdataRoot?: string,
): string {
  return path.join(
    datasetPath(dataset, testdataRoot),
    RESULTS_DIR,
    resultName,
    RUN_MANIFEST_DIR,
    RUN_MANIFEST_FILE,
  );
}

function previousRunPath(dataset: string, testdataRoot?: string): string {
  return path.join(
    datasetPath(dataset, testdataRoot),
    RESULTS_DIR,
    PREVIOUS_RUN_FILE,
  );
}

function parseJsonFile(filePath: string, contents: string): unknown {
  try {
    return JSON.parse(contents);
  } catch (error: unknown) {
    throw new Error(`Invalid JSON in ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function readRunManifest(
  manifestPath: string,
  description: string,
): RunManifest | null {
  let contents: string;
  try {
    contents = fs.readFileSync(manifestPath, "utf8");
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw new Error(
      `Could not read ${description} manifest ${manifestPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  try {
    return runManifestSchema.parse(parseJsonFile(manifestPath, contents));
  } catch (error: unknown) {
    throw new Error(
      `Invalid ${description} manifest ${manifestPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function writeRunManifest(manifestPath: string, manifest: RunManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export class BenchmarkRun {
  readonly startTime: number;
  readonly dataset: string;
  readonly resultName: string;
  readonly results: BenchResult[] = [];

  constructor(
    dataset: string,
    resultName: string,
    startTime = Math.floor(Date.now() / 1000),
    private readonly testdataRoot?: string,
  ) {
    this.dataset = dataset;
    this.resultName = resultName;
    this.startTime = startTime;
  }

  loadPrevious(): BenchmarkRun | null {
    const manifestPath = previousRunPath(this.dataset, this.testdataRoot);
    const manifest = readRunManifest(manifestPath, "previous run");
    if (!manifest) {
      return null;
    }
    if (manifest.dataset !== this.dataset) {
      throw new Error(
        `Previous run manifest ${manifestPath} is for dataset '${manifest.dataset}', expected '${this.dataset}'`,
      );
    }

    const previous = new BenchmarkRun(
      manifest.dataset,
      manifest.engine,
      manifest.startTime,
      this.testdataRoot,
    );
    for (const queryId of manifest.queryIds) {
      const result = BenchResult.load(
        manifest.dataset,
        manifest.engine,
        queryId,
        this.testdataRoot,
      );
      if (!result) {
        throw new Error(
          `Previous run manifest ${manifestPath} references missing result '${queryId}' for result name '${manifest.engine}'`,
        );
      }
      previous.results.push(result);
    }
    return previous;
  }

  loadResults(): void {
    const manifestPath = runManifestPath(
      this.dataset,
      this.resultName,
      this.testdataRoot,
    );
    const manifest = readRunManifest(manifestPath, "result");
    if (!manifest) {
      this.results.splice(
        0,
        this.results.length,
        ...BenchResult.loadMany(
          this.dataset,
          this.resultName,
          this.testdataRoot,
        ),
      );
      return;
    }
    if (
      manifest.dataset !== this.dataset ||
      manifest.engine !== this.resultName
    ) {
      throw new Error(
        `Result manifest ${manifestPath} identifies ${manifest.dataset}/${manifest.engine}, expected ${this.dataset}/${this.resultName}`,
      );
    }

    const results = manifest.queryIds.map((queryId) => {
      const result = BenchResult.load(
        this.dataset,
        this.resultName,
        queryId,
        this.testdataRoot,
      );
      if (!result) {
        throw new Error(
          `Engine run manifest ${manifestPath} references missing result '${queryId}'`,
        );
      }
      return result;
    });
    this.results.splice(0, this.results.length, ...results);
  }

  store(): void {
    const manifest = runManifestSchema.parse({
      version: 1,
      startTime: this.startTime,
      dataset: this.dataset,
      engine: this.resultName,
      queryIds: this.results.map((result) => result.id),
    });
    for (const result of this.results) {
      result.store();
    }
    writeRunManifest(
      runManifestPath(this.dataset, this.resultName, this.testdataRoot),
      manifest,
    );
    writeRunManifest(
      previousRunPath(this.dataset, this.testdataRoot),
      manifest,
    );
  }

  comparison(other: BenchmarkRun): string {
    const lines = [
      `=== Comparing ${this.dataset} results '${other.resultName}' [prev] with '${this.resultName}' [new] ===`,
    ];
    let totalTimePrev = 0;
    let totalTimeNew = 0;
    let totalTasksPrev = 0;
    let totalTasksNew = 0;
    const statsQErrorP50Prev: number[] = [];
    const statsQErrorP50New: number[] = [];
    const statsQErrorP95Prev: number[] = [];
    const statsQErrorP95New: number[] = [];
    for (const query of this.results) {
      const prevQuery = other.results.find((value) => value.id === query.id);
      if (!prevQuery) {
        continue;
      }
      const timePrev = prevQuery.representativeTime();
      const timeNew = query.representativeTime();
      if (timePrev !== undefined && timeNew !== undefined) {
        totalTimePrev += timePrev;
        totalTimeNew += timeNew;
        const tasksPrev = prevQuery.averageTasks();
        const tasksNew = query.averageTasks();
        if (tasksPrev !== undefined && tasksNew !== undefined) {
          totalTasksPrev += tasksPrev;
          totalTasksNew += tasksNew;
        }
        statsQErrorP50Prev.push(
          ...prevQuery.iterations.flatMap((iteration) =>
            iteration.statsQErrorP50 === undefined
              ? []
              : [iteration.statsQErrorP50],
          ),
        );
        statsQErrorP50New.push(
          ...query.iterations.flatMap((iteration) =>
            iteration.statsQErrorP50 === undefined
              ? []
              : [iteration.statsQErrorP50],
          ),
        );
        statsQErrorP95Prev.push(
          ...prevQuery.iterations.flatMap((iteration) =>
            iteration.statsQErrorP95 === undefined
              ? []
              : [iteration.statsQErrorP95],
          ),
        );
        statsQErrorP95New.push(
          ...query.iterations.flatMap((iteration) =>
            iteration.statsQErrorP95 === undefined
              ? []
              : [iteration.statsQErrorP95],
          ),
        );
      }

      lines.push(query.comparison(prevQuery));
    }

    let factor: number;
    let tag: string;
    let emoji: string;
    if (totalTimeNew < totalTimePrev) {
      factor = totalTimePrev / totalTimeNew;
      tag = "faster";
      emoji = factor >= TOTAL_HIGHLIGHT_THRESHOLD ? "✅" : "✔";
    } else {
      factor = totalTimeNew / totalTimePrev;
      tag = "slower";
      emoji = factor >= TOTAL_HIGHLIGHT_THRESHOLD ? "❌" : "✖";
    }

    const qErrorP50 = qErrorComparison(
      "QERR P50",
      statsQErrorP50Prev,
      statsQErrorP50New,
    );
    const qErrorP95 = qErrorComparison(
      "QERR P95",
      statsQErrorP95Prev,
      statsQErrorP95New,
    );
    if (qErrorP50) lines.push(qErrorP50);
    if (qErrorP95) lines.push(qErrorP95);
    lines.push(
      `${taskComparison("TASKS", totalTasksPrev, totalTasksNew)} (sum of per-query averages)`,
    );
    lines.push(
      `${"TOTAL".padStart(8)}: prev=${totalTimePrev.toString()} ms, new=${totalTimeNew.toString()} ms, diff=${factor.toFixed(2)} ${tag} ${emoji}`,
    );
    return lines.join("\n");
  }
}

export class BenchResult {
  readonly id: string;
  readonly dataset: string;
  readonly resultName: string;
  iterations: QueryIter[] = [];

  constructor(
    dataset: string,
    resultName: string,
    id: string,
    private readonly testdataRoot?: string,
  ) {
    this.dataset = dataset;
    this.resultName = resultName;
    this.id = id;
  }

  p50(): number {
    const values = this.iterations
      .filter((iteration) => !iteration.error)
      .map((iteration) => iteration.elapsed)
      .sort((left, right) => left - right);
    if (values.length === 0) {
      return 0;
    }
    const middle = Math.floor(values.length / 2);
    const upper = values[middle];
    if (upper === undefined) {
      throw new Error("Could not calculate benchmark median");
    }
    if (values.length % 2 === 1) {
      return Math.round(upper);
    }
    const lower = values[middle - 1];
    if (lower === undefined) {
      throw new Error("Could not calculate benchmark median");
    }
    return Math.round((lower + upper) / 2);
  }

  representativeTime(): number | undefined {
    if (this.iterations.some((iteration) => iteration.error)) {
      return undefined;
    }
    return this.p50();
  }

  averageTasks(): number | undefined {
    const values = this.iterations
      .filter((iteration) => !iteration.error)
      .map((iteration) => iteration.tasks);
    if (values.length === 0) {
      return undefined;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  comparison(prevQuery: BenchResult): string {
    const prevError = prevQuery.iterations.find((value) => value.error)?.error;
    const newError = this.iterations.find((value) => value.error)?.error;

    if (prevError && !newError) {
      return `${this.id}: Previously failed, but now succeeded 🟠`;
    }
    if (!prevError && newError) {
      return `${this.id}: Previously succeeded, but now failed ❌`;
    }
    if (prevError && newError) {
      return `${this.id}: Previously failed, and now also failed ❌`;
    }

    const p50Prev = prevQuery.p50();
    const p50 = this.p50();
    const tasksPrev = prevQuery.averageTasks();
    const tasks = this.averageTasks();

    let factor: number;
    let tag: string;
    let emoji: string;
    if (p50 < p50Prev) {
      factor = p50Prev / p50;
      tag = "faster";
      emoji = factor >= QUERY_HIGHLIGHT_THRESHOLD ? "✅" : "✔";
    } else {
      factor = p50 / p50Prev;
      tag = "slower";
      emoji = factor >= QUERY_HIGHLIGHT_THRESHOLD ? "❌" : "✖";
    }

    const timeComparison = `${this.id.padStart(8)}: prev=${p50Prev.toString().padStart(4)} ms, new=${p50.toString().padStart(4)} ms, diff=${factor.toFixed(2)} ${tag} ${emoji}`;
    if (tasksPrev === undefined || tasks === undefined) {
      return timeComparison;
    }
    return `${timeComparison}, ${taskComparison("tasks", tasksPrev, tasks).trimStart()}`;
  }

  store(): void {
    const filePath = resultFilePath(
      this.dataset,
      this.resultName,
      this.id,
      this.testdataRoot,
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(
        {
          dataset: this.dataset,
          engine: this.resultName,
          id: this.id,
          iterations: this.iterations,
        },
        null,
        2,
      )}\n`,
    );
  }

  static load(
    dataset: string,
    resultName: string,
    id: string,
    testdataRoot?: string,
  ): BenchResult | null {
    const filePath = resultFilePath(dataset, resultName, id, testdataRoot);
    let contents: string;
    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw new Error(
        `Could not read benchmark result ${filePath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    let parsed: z.infer<typeof benchResultSchema>;
    try {
      parsed = benchResultSchema.parse(parseJsonFile(filePath, contents));
    } catch (error: unknown) {
      throw new Error(
        `Invalid benchmark result ${filePath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (
      parsed.dataset !== dataset ||
      parsed.engine !== resultName ||
      parsed.id !== id
    ) {
      throw new Error(
        `Benchmark result ${filePath} identifies ${parsed.dataset}/${parsed.engine}/${parsed.id}, expected ${dataset}/${resultName}/${id}`,
      );
    }

    const result = new BenchResult(
      parsed.dataset,
      parsed.engine,
      parsed.id,
      testdataRoot,
    );
    result.iterations = parsed.iterations.map((iteration) => {
      const value: QueryIter = {
        rowCount: iteration.rowCount,
        elapsed: iteration.elapsed,
        plan: iteration.plan,
        tasks: iteration.tasks,
      };
      if (iteration.error !== undefined) {
        value.error = iteration.error;
      }
      if (iteration.statsQErrorP50 !== undefined) {
        value.statsQErrorP50 = iteration.statsQErrorP50;
      }
      if (iteration.statsQErrorP95 !== undefined) {
        value.statsQErrorP95 = iteration.statsQErrorP95;
      }
      return value;
    });
    return result;
  }

  static loadMany(
    dataset: string,
    resultName: string,
    testdataRoot?: string,
  ): BenchResult[] {
    const resultsDir = path.join(
      datasetPath(dataset, testdataRoot),
      RESULTS_DIR,
      resultName,
    );
    let files: string[];
    try {
      files = fs.readdirSync(resultsDir);
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw new Error(
        `Could not list benchmark results in ${resultsDir}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    const results: BenchResult[] = [];
    for (const fileName of files) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const id = fileName.slice(0, -5);
      const result = BenchResult.load(dataset, resultName, id, testdataRoot);
      if (!result) {
        throw new Error(
          `Benchmark result disappeared while reading ${resultsDir}`,
        );
      }
      results.push(result);
    }

    results.sort((left, right) => compareQueryIds(left.id, right.id));
    return results;
  }
}

function qErrorComparison(
  label: string,
  previous: number[],
  next: number[],
): string | undefined {
  const previousValue = median(previous);
  const nextValue = median(next);
  if (previousValue !== undefined && nextValue !== undefined) {
    return `${label.padStart(8)}: prev=${previousValue.toFixed(2)}x, new=${nextValue.toFixed(2)}x`;
  }
  if (previousValue !== undefined) {
    return `${label.padStart(8)}: prev=${previousValue.toFixed(2)}x, new=n/a`;
  }
  if (nextValue !== undefined) {
    return `${label.padStart(8)}: prev=n/a, new=${nextValue.toFixed(2)}x`;
  }
  return undefined;
}

function taskComparison(label: string, previous: number, next: number): string {
  let difference: string;
  if (next === previous) {
    difference = "no change";
  } else if (previous === 0) {
    difference = `${formatTasks(next)} more`;
  } else {
    const absolute = Math.abs(next - previous);
    const percentage = (absolute / previous) * 100;
    difference = `${formatTasks(absolute)} ${next < previous ? "fewer" : "more"} (${percentage.toFixed(1)}%)`;
  }
  return `${label.padStart(8)}: prev=${formatTasks(previous)}, new=${formatTasks(next)}, diff=${difference}`;
}

function formatTasks(value: number): string {
  return value.toFixed(1);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) {
    return undefined;
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1];
  return lower === undefined ? undefined : (lower + upper) / 2;
}
