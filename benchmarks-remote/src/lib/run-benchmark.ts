import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { getBucketUri } from "./bucket";
import { errorMessage, isNotFoundError } from "./filesystem";
import { datasetParts, datasetPath } from "./paths";
import { compareQueryIds } from "./query-order";
import { BenchmarkRun, BenchResult, type QueryIter } from "./results";
import type { BenchmarkRunner, TableSpec } from "./runner";

export interface BenchmarkOptions {
  dataset: string;
  engine: string;
  iterations: number;
  timeSecs: number;
  queries: string[];
  debug: boolean;
  warmup: boolean;
  now?: () => number;
}

async function isNonEmptyParquetDirectory(directory: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error: unknown) {
    if (
      isNotFoundError(error) ||
      (error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOTDIR")
    ) {
      return false;
    }
    throw new Error(
      `Could not inspect possible table directory ${directory}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return (
    entries.length > 0 && entries.every((file) => file.endsWith(".parquet"))
  );
}

export async function tablePathsForDataset(
  dataset: string,
): Promise<TableSpec[]> {
  const localDatasetPath = datasetPath(dataset);
  const bucketUri = getBucketUri();
  const [suite] = datasetParts(dataset);
  const schema = dataset.replaceAll("/", "_");

  let entries: string[];
  try {
    entries = await fs.readdir(localDatasetPath);
  } catch (error: unknown) {
    throw new Error(
      `Could not list dataset '${dataset}' at ${localDatasetPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const tables: TableSpec[] = [];
  for (const entryName of entries) {
    const directory = path.join(localDatasetPath, entryName);
    if (await isNonEmptyParquetDirectory(directory)) {
      tables.push({
        suite,
        name: entryName,
        schema,
        s3Path: `${bucketUri}/${dataset}/${entryName}/`,
      });
    }
  }
  if (tables.length === 0) {
    throw new Error(
      `Dataset '${dataset}' contains no non-empty table directories made entirely of Parquet files`,
    );
  }
  return tables;
}

interface QuerySpec {
  id: string;
  sql: string;
}

export async function queriesForDataset(dataset: string): Promise<QuerySpec[]> {
  const [suite] = datasetParts(dataset);
  const queriesPath = path.join(path.dirname(datasetPath(dataset)), "queries");

  let entries: string[];
  try {
    entries = await fs.readdir(queriesPath);
  } catch (error: unknown) {
    throw new Error(
      `Could not list queries for suite '${suite}' at ${queriesPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const queries: QuerySpec[] = [];
  for (const fileName of entries.filter((entry) => entry.endsWith(".sql"))) {
    const queryPath = path.join(queriesPath, fileName);
    try {
      queries.push({
        id: fileName.slice(0, -4),
        sql: await fs.readFile(queryPath, "utf8"),
      });
    } catch (error: unknown) {
      throw new Error(
        `Could not read query file ${queryPath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  queries.sort((left, right) => compareQueryIds(left.id, right.id));
  if (queries.length === 0) {
    throw new Error(
      `No SQL query files were found for suite '${suite}' at ${queriesPath}`,
    );
  }
  return queries;
}

function failedIteration(error: unknown): QueryIter {
  return {
    elapsed: 0,
    rowCount: 0,
    error: errorMessage(error),
    plan: "",
    tasks: 0,
  };
}

export async function runBenchmark(
  runner: BenchmarkRunner,
  options: BenchmarkOptions,
): Promise<BenchmarkRun> {
  const {
    dataset,
    engine,
    iterations,
    timeSecs,
    queries: selectedQueries,
    warmup,
    debug,
  } = options;
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new Error(`Iterations must be a positive integer, got ${iterations}`);
  }
  if (!Number.isFinite(timeSecs) || timeSecs < 0) {
    throw new Error(
      `Time must be a non-negative number of seconds, got ${timeSecs}`,
    );
  }
  const now = options.now ?? (() => performance.now());
  const availableQueries = await queriesForDataset(dataset);
  const availableIds = new Set(availableQueries.map((query) => query.id));
  const unknownQueries = selectedQueries.filter(
    (query) => !availableIds.has(query),
  );
  if (unknownQueries.length > 0) {
    throw new Error(
      `Unknown query ID(s) for '${dataset}': ${unknownQueries.join(", ")}`,
    );
  }

  const benchmarkRun = new BenchmarkRun(dataset, engine);

  console.error("Creating tables...");
  await runner.createTables(await tablePathsForDataset(dataset));

  for (const { id, sql } of availableQueries) {
    if (selectedQueries.length > 0 && !selectedQueries.includes(id)) {
      continue;
    }

    const result = new BenchResult(dataset, engine, id);

    if (warmup) {
      console.error(`Warming up query ${id}...`);
      try {
        await runner.executeQuery(sql);
      } catch (error: unknown) {
        result.iterations.push(failedIteration(error));
        console.error(`Query ${id} failed: ${errorMessage(error)}`);
        benchmarkRun.results.push(result);
        continue;
      }
    }

    const queryStarted = now();
    let iteration = 0;
    while (iteration < iterations || now() - queryStarted < timeSecs * 1000) {
      let response;
      try {
        response = await runner.executeQuery(sql);
      } catch (error: unknown) {
        result.iterations.push(failedIteration(error));
        console.error(`Query ${id} failed: ${errorMessage(error)}`);
        break;
      }

      if (debug) {
        console.error(response.plan);
      }
      const recorded: QueryIter = {
        elapsed: response.elapsed,
        rowCount: response.rowCount,
        plan: response.plan,
        tasks: response.tasks,
      };
      if (response.statsQErrorP50 !== undefined) {
        recorded.statsQErrorP50 = response.statsQErrorP50;
      }
      if (response.statsQErrorP95 !== undefined) {
        recorded.statsQErrorP95 = response.statsQErrorP95;
      }
      result.iterations.push(recorded);

      if (
        response.statsQErrorP50 !== undefined &&
        response.statsQErrorP95 !== undefined
      ) {
        console.error(
          `Query ${id} iteration ${iteration} took ${Math.round(response.elapsed)} ms, stats q-error P50 ${response.statsQErrorP50.toFixed(2)}x, P95 ${response.statsQErrorP95.toFixed(2)}x and returned ${response.rowCount} rows`,
        );
      } else {
        console.error(
          `Query ${id} iteration ${iteration} took ${Math.round(response.elapsed)} ms and returned ${response.rowCount} rows`,
        );
      }
      iteration += 1;
    }

    console.error(`Query ${id} p50 time: ${result.p50()} ms`);
    benchmarkRun.results.push(result);
  }

  return benchmarkRun;
}
