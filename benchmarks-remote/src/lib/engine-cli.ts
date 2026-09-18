import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import {
  argument,
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
  WithDefaultError,
  type InferValue,
  type ValueParser,
} from "@optique/core";

import { getLocalFoundationConfiguration } from "./pulumi-output";
import { errorMessage } from "./filesystem";
import { discoverDatasetTables, type ReadDirectory } from "./dataset-formats";
import {
  datasetParts,
  datasetPath,
  DEFAULT_DATAFUSION_DISTRIBUTED_ROOT,
  DEV_TOOLS_ROOT,
} from "./paths";
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
  bucket: withDefault(
    option("--bucket", string({ metavar: "URI" }), {
      description: message`S3 bucket containing benchmark data`,
    }),
    () => {
      const bucket = getLocalFoundationConfiguration()?.bucket;
      if (bucket === undefined) {
        throw new WithDefaultError(
          message`Could not resolve --bucket. Run npm run foundation-deploy to generate the local Pulumi outputs, or pass --bucket manually.`,
        );
      }
      return bucket;
    },
  ),
  clusterName: withDefault(
    option("--k8s-cluster", string({ metavar: "NAME" }), {
      description: message`Benchmark Kubernetes cluster`,
    }),
    () => {
      const clusterName = getLocalFoundationConfiguration()?.clusterName;
      if (clusterName === undefined) {
        throw new WithDefaultError(
          message`Could not resolve --k8s-cluster. Run npm run foundation-deploy to generate the local Pulumi outputs, or pass --k8s-cluster manually.`,
        );
      }
      return clusterName;
    },
  ),
  dataset: argument(string({ metavar: "DATASET" }), {
    description: message`Dataset to run queries on`,
  }),
  iterations: withDefault(
    option("-i", "--iterations", integerValue, {
      description: message`Number of iterations`,
    }),
    5,
  ),
  kubeconfig: withDefault(
    option("--kubeconfig", string({ metavar: "PATH" }), {
      description: message`Path to the Kubernetes configuration`,
    }),
    path.join(DEV_TOOLS_ROOT, "benchmarks-remote", "k8s", ".kubeconfig"),
  ),
  region: withDefault(
    option("--region", string({ metavar: "REGION" }), {
      description: message`AWS region containing the cluster`,
    }),
    "us-east-1",
  ),
  service: optional(
    option("--k8s-service", string({ metavar: "NAME" }), {
      description: message`Kubernetes service to port-forward`,
    }),
  ),
  testdataRoot: withDefault(
    option("--testdata-root", string({ metavar: "PATH" }), {
      description: message`Benchmark testdata directory`,
    }),
    path.resolve(DEFAULT_DATAFUSION_DISTRIBUTED_ROOT, "testdata"),
  ),
  timeSecs: withDefault(
    option("--time-secs", numberValue, {
      description: message`Minimum measured time per query in seconds`,
    }),
    0,
  ),
  url: withDefault(
    option("--url", string({ metavar: "URL" }), {
      description: message`Benchmark engine URL`,
    }),
    "http://localhost:9000",
  ),
  queries: optional(
    option("--queries", string({ metavar: "QUERIES" }), {
      description: message`Comma-separated query IDs to run`,
    }),
  ),
  debug: withDefault(
    option("--debug", booleanValue, {
      description: message`Print generated plans to stderr`,
    }),
    false,
  ),
  warmup: withDefault(
    option("--warmup", booleanValue, {
      description: message`Perform a warmup query before the benchmarks`,
    }),
    true,
  ),
  compare: map(
    option("--no-compare", {
      description: message`Do not compare against the previous stored run`,
    }),
    (disabled) => !disabled,
  ),
});

export type CommonOptions = InferValue<typeof CommonOptions>;

function s3BucketAndPrefix(bucket: string): {
  bucketName: string;
  prefix: string;
} {
  const parts = bucket
    .replace(/^s3:\/\//, "")
    .replace(/^\/+|\/+$/g, "")
    .split("/");
  const bucketName = parts.shift();
  if (bucketName === undefined || bucketName.length === 0) {
    throw new Error(`Invalid S3 bucket '${bucket}'`);
  }
  return {
    bucketName,
    prefix: parts.length === 0 ? "" : `${parts.join("/")}/`,
  };
}

export function readS3Directory(
  client: S3Client,
  bucket: string,
): ReadDirectory {
  return async (directory) => {
    const entries: string[] = [];
    const prefix = `${directory}/`;
    let continuationToken: string | undefined;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: "/",
          ContinuationToken: continuationToken,
        }),
      );
      for (const { Key } of response.Contents ?? []) {
        if (Key && Key !== prefix) entries.push(Key.slice(prefix.length));
      }
      for (const { Prefix } of response.CommonPrefixes ?? []) {
        if (Prefix) entries.push(Prefix.slice(prefix.length));
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
    return entries;
  };
}

export async function tablePathsForDataset(
  dataset: string,
  bucket: string,
  region: string,
): Promise<TableSpec[]> {
  const bucketUri = `s3://${bucket.replace(/^s3:\/\//, "").replace(/\/+$/, "")}`;
  const [suite] = datasetParts(dataset);
  const schema = dataset.replaceAll("/", "_");
  const { bucketName, prefix } = s3BucketAndPrefix(bucket);
  const client = new S3Client({ region });
  let tables;
  try {
    tables = await discoverDatasetTables(
      `${prefix}${dataset}`,
      readS3Directory(client, bucketName),
    );
  } finally {
    client.destroy();
  }
  if (tables.length === 0) {
    throw new Error(
      `Dataset '${dataset}' contains no supported tables in ${bucketUri}`,
    );
  }
  return tables.map(({ name, format }) => ({
    suite,
    schema,
    name,
    fileType: format.fileType,
    s3Path: `${bucketUri}/${dataset}/${name}/${format.entryPoint}`,
  }));
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

    const portForwardConfiguration = {
      ...options,
      deployment: runner.deployment,
      service: options.service ?? runner.defaultService ?? runner.deployment,
    };
    await withKubectlPortForward(portForwardConfiguration, async () => {
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
        runner.resultName,
        undefined,
        options.testdataRoot,
      );

      console.error("Creating tables...");
      const tableSpecs = await tablePathsForDataset(
        dataset,
        options.bucket,
        options.region,
      );
      const formats = runner.supportedFileTypes ?? ["PARQUET"];
      for (const table of tableSpecs) {
        if (!formats.includes(table.fileType)) {
          throw new Error(
            `${runner.deployment} does not support ${table.fileType} benchmark tables`,
          );
        }
      }
      await runner.createTables(tableSpecs);

      for (const { id, sql } of availableQueries) {
        if (selectedQueries.length > 0 && !selectedQueries.includes(id)) {
          continue;
        }

        const result = new BenchResult(
          dataset,
          runner.resultName,
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
