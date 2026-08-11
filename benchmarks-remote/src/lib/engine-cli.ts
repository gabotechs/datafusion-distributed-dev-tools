import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  choice,
  float,
  integer,
  map,
  message,
  object,
  option,
  optional,
  string,
  transform,
  withDefault,
  type InferValue,
  type ValueParser,
} from "@optique/core";

import { errorMessage, isNotFoundError } from "./filesystem";
import { datasetParts, datasetPath, DEV_TOOLS_ROOT } from "./paths";
import { withKubectlPortForward } from "./port-forward";
import { compareQueryIds } from "./query-order";
import { BenchmarkRun, BenchResult, type QueryIter } from "./results";
import type { BenchmarkRunner, TableSpec } from "./runner";

export const integerValue: ValueParser<"sync", number> = integer();
export const numberValue: ValueParser<"sync", number> = float();
export const booleanValue: ValueParser<"sync", boolean> = transform(
  choice(["true", "false"], { metavar: "BOOLEAN" }),
  {
    map: (value) => value === "true",
    unmap: (value) => (value ? "true" : "false"),
  },
);
export const CommonOptions = object({
  /** S3 bucket containing the benchmark datasets. */
  bucket: option("--bucket", string({ metavar: "URI" }), {
    description: message`S3 bucket containing benchmark data`,
  }),
  /** Kubernetes context and EKS cluster name. */
  clusterName: option("--cluster-name", string({ metavar: "NAME" }), {
    description: message`Benchmark Kubernetes cluster`,
  }),
  /** Dataset identifier, such as tpch/sf1. */
  dataset: option("--dataset", string({ metavar: "DATASET" }), {
    description: message`Dataset to run queries on`,
  }),
  /** Engine deployment whose namespace contains the service. */
  deployment: option("--deployment", string({ metavar: "NAME" }), {
    description: message`Benchmark engine deployment`,
  }),
  /** Minimum number of measured executions per query. */
  iterations: withDefault(
    option("-i", "--iterations", integerValue, {
      description: message`Number of iterations`,
    }),
    5,
  ),
  /** Path to the kubeconfig containing the benchmark cluster context. */
  kubeconfig: withDefault(
    option("--kubeconfig", string({ metavar: "PATH" }), {
      description: message`Path to the Kubernetes configuration`,
    }),
    path.join(DEV_TOOLS_ROOT, "benchmarks-remote", "k8s", ".kubeconfig"),
  ),
  /** AWS region containing the benchmark cluster. */
  region: withDefault(
    option("--region", string({ metavar: "REGION" }), {
      description: message`AWS region containing the cluster`,
    }),
    "us-east-1",
  ),
  /** Kubernetes service exposed through the local port-forward. */
  service: option("--service", string({ metavar: "NAME" }), {
    description: message`Kubernetes service to port-forward`,
  }),
  /** Local directory containing benchmark queries and result files. */
  testdataRoot: withDefault(
    option("--testdata-root", string({ metavar: "PATH" }), {
      description: message`Benchmark testdata directory`,
    }),
    path.resolve(DEV_TOOLS_ROOT, "../datafusion-distributed/testdata"),
  ),
  /** Minimum measured duration per query. */
  timeSecs: withDefault(
    option("--time-secs", numberValue, {
      description: message`Minimum measured time per query in seconds`,
    }),
    0,
  ),
  /** Engine endpoint reached through the port-forward. */
  url: withDefault(
    option("--url", string({ metavar: "URL" }), {
      description: message`Benchmark engine URL`,
    }),
    "http://localhost:9000",
  ),
  /** Optional comma-separated query selection. */
  queries: optional(
    option("--queries", string({ metavar: "QUERIES" }), {
      description: message`Comma-separated query IDs to run`,
    }),
  ),
  /** Whether to print query plans. */
  debug: withDefault(
    option("--debug", booleanValue, {
      description: message`Print generated plans to stderr`,
    }),
    false,
  ),
  /** Whether to execute a warmup query. */
  warmup: withDefault(
    option("--warmup", booleanValue, {
      description: message`Perform a warmup query before the benchmarks`,
    }),
    true,
  ),
  /** Whether to compare against the previous stored run. */
  compare: map(
    option("--no-compare", {
      description: message`Do not compare against the previous stored run`,
    }),
    (disabled) => !disabled,
  ),
});

export type CommonOptions = InferValue<typeof CommonOptions>;

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
  testdataRoot: string,
  bucket: string,
): Promise<TableSpec[]> {
  const localDatasetPath = datasetPath(dataset, testdataRoot);
  const bucketUri = `s3://${bucket.replace(/^s3:\/\//, "").replace(/\/+$/, "")}`;
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

export async function queriesForDataset(
  dataset: string,
  testdataRoot: string,
): Promise<QuerySpec[]> {
  const [suite] = datasetParts(dataset);
  const queriesPath = path.join(
    path.dirname(datasetPath(dataset, testdataRoot)),
    "queries",
  );

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

function queryArguments(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const queries = value
    .split(",")
    .map((query) => query.trim())
    .filter(Boolean);
  if (queries.length === 0) {
    throw new Error("--queries must contain at least one query ID");
  }
  return queries;
}

export async function runEngineBenchmark(
  runner: BenchmarkRunner,
): Promise<void> {
  const options = runner.options;
  const { dataset, iterations, timeSecs, warmup, debug } = options;
  try {
    const selectedQueries = queryArguments(options.queries);
    if (!Number.isSafeInteger(iterations) || iterations <= 0) {
      throw new Error(
        `Iterations must be a positive integer, got ${iterations}`,
      );
    }
    if (!Number.isFinite(timeSecs) || timeSecs < 0) {
      throw new Error(
        `Time must be a non-negative number of seconds, got ${timeSecs}`,
      );
    }

    await withKubectlPortForward(options, async () => {
      const availableQueries = await queriesForDataset(
        dataset,
        options.testdataRoot,
      );
      const availableIds = new Set(availableQueries.map((query) => query.id));
      const unknownQueries = selectedQueries.filter(
        (query) => !availableIds.has(query),
      );
      if (unknownQueries.length > 0) {
        throw new Error(
          `Unknown query ID(s) for '${dataset}': ${unknownQueries.join(", ")}`,
        );
      }

      const benchmarkRun = new BenchmarkRun(
        dataset,
        runner.engine,
        undefined,
        options.testdataRoot,
      );

      console.error("Creating tables...");
      await runner.createTables(
        await tablePathsForDataset(
          dataset,
          options.testdataRoot,
          options.bucket,
        ),
      );

      for (const { id, sql } of availableQueries) {
        if (selectedQueries.length > 0 && !selectedQueries.includes(id)) {
          continue;
        }

        const result = new BenchResult(
          dataset,
          runner.engine,
          id,
          options.testdataRoot,
        );

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

        const queryStarted = performance.now();
        let iteration = 0;
        while (
          iteration < iterations ||
          performance.now() - queryStarted < timeSecs * 1000
        ) {
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

      const previous = options.compare ? benchmarkRun.loadPrevious() : null;
      if (previous) console.log(benchmarkRun.comparison(previous));
      benchmarkRun.store();
    });
    console.error("Benchmark run completed");
  } catch (error: unknown) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
