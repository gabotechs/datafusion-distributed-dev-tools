import { z } from "zod";

import {
  merge,
  message,
  object,
  option,
  optional,
  string,
  withDefault,
  type InferValue,
} from "@optique/core";
import { runSync } from "@optique/run";

import {
  booleanValue,
  CommonOptions,
  integerValue,
  numberValue,
  runEngineBenchmark,
} from "../lib/engine-cli";
import { datafusionDistributedGitReference } from "../lib/git-reference";
import type { ExecuteQueryResult, TableSpec } from "../lib/runner";
import { splitViewQuery, type BenchmarkRunner } from "../lib/runner";

const Options = object({
  resultName: withDefault(
    option("--result-name", string({ metavar: "NAME" }), {
      description: message`Name used to store benchmark results`,
    }),
    () => `datafusion-distributed-${datafusionDistributedGitReference()}`,
  ),
  fileScanConfigBytesPerPartition: optional(
    option("--file-scan-config-bytes-per-partition", integerValue, {
      description: message`Bytes each partition scans`,
    }),
  ),
  cardinalityTaskSf: optional(
    option("--cardinality-task-sf", numberValue, {
      description: message`Cardinality task scale factor`,
    }),
  ),
  batchSize: optional(
    option("--batch-size", integerValue, {
      description: message`Standard batch coalescing size`,
    }),
  ),
  shuffleBatchSize: optional(
    option("--shuffle-batch-size", integerValue, {
      description: message`Worker RepartitionExec batch size`,
    }),
  ),
  childrenIsolatorUnions: optional(
    option("--children-isolator-unions", booleanValue, {
      description: message`Use children isolator unions`,
    }),
  ),
  broadcastJoins: optional(
    option("--broadcast-joins", booleanValue, {
      description: message`Use broadcast joins`,
    }),
  ),
  partialReduce: optional(
    option("--partial-reduce", booleanValue, {
      description: message`Enable PartialReduce optimization`,
    }),
  ),
  collectMetrics: optional(
    option("--collect-metrics", booleanValue, {
      description: message`Propagate metric collection`,
    }),
  ),
  compression: optional(
    option("--compression", string({ metavar: "CODEC" }), {
      description: message`Worker compression codec`,
    }),
  ),
  maxTasksPerStage: optional(
    option("--max-tasks-per-stage", integerValue, {
      description: message`Maximum tasks per stage`,
    }),
  ),
  repartitionFileMinSize: optional(
    option("--repartition-file-min-size", integerValue, {
      description: message`DataFusion repartition file minimum size`,
    }),
  ),
  targetPartitions: optional(
    option("--target-partitions", integerValue, {
      description: message`DataFusion target partition count`,
    }),
  ),
  dynamic: optional(
    option("--dynamic", booleanValue, {
      description: message`Use dynamic task count assignment`,
    }),
  ),
  dynamicBytesPerPartition: optional(
    option("--dynamic-bytes-per-partition", integerValue, {
      description: message`Dynamic allocation bytes per partition`,
    }),
  ),
});

const DataFusionOptions = merge(CommonOptions, Options);

type DataFusionOptions = InferValue<typeof DataFusionOptions>;

const queryResponseSchema = z.object({
  count: z.number(),
  plan: z.string(),
  elapsed_ms: z.number(),
  tasks: z.number(),
  stats_q_error_p50: z.number().nullable(),
  stats_q_error_p95: z.number().nullable(),
});
type QueryResponse = z.infer<typeof queryResponseSchema>;

export interface DataFusionSettingOptions {
  fileScanConfigBytesPerPartition?: number | undefined;
  cardinalityTaskSf?: number | undefined;
  batchSize?: number | undefined;
  shuffleBatchSize?: number | undefined;
  collectMetrics?: boolean | undefined;
  compression?: string | undefined;
  childrenIsolatorUnions?: boolean | undefined;
  broadcastJoins?: boolean | undefined;
  partialReduce?: boolean | undefined;
  dynamic?: boolean | undefined;
  dynamicBytesPerPartition?: number | undefined;
  maxTasksPerStage?: number | undefined;
  repartitionFileMinSize?: number | undefined;
  targetPartitions?: number | undefined;
}

export class DataFusionRunner implements BenchmarkRunner {
  readonly deployment = "datafusion";
  readonly resultName: string;

  constructor(public readonly options: DataFusionOptions) {
    this.resultName = options.resultName;
  }

  async executeQuery(sql: string): Promise<ExecuteQueryResult> {
    const viewQuery = splitViewQuery(sql);
    let response: QueryResponse;
    if (viewQuery) {
      const [createView, query, dropView] = viewQuery;
      await this.query(createView);
      response = await this.query(query);
      await this.query(dropView);
    } else {
      response = await this.query(sql);
    }

    const result: ExecuteQueryResult = {
      rowCount: response.count,
      plan: response.plan,
      elapsed: response.elapsed_ms,
      tasks: response.tasks,
    };
    if (response.stats_q_error_p50 !== null) {
      result.statsQErrorP50 = response.stats_q_error_p50;
    }
    if (response.stats_q_error_p95 !== null) {
      result.statsQErrorP95 = response.stats_q_error_p95;
    }
    return result;
  }

  private async query(sql: string): Promise<QueryResponse> {
    const url = new URL(this.options.url);
    url.searchParams.set("sql", sql);
    const response = await fetch(url);

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Query failed: ${response.status} ${message}`);
    }
    return queryResponseSchema.parse(await response.json());
  }

  async createTables(tables: TableSpec[]): Promise<void> {
    let statement = "";
    for (const table of tables) {
      statement += `
    DROP TABLE IF EXISTS ${table.name};
    CREATE EXTERNAL TABLE IF NOT EXISTS ${table.name} STORED AS PARQUET LOCATION '${table.s3Path}';
 `;
    }
    await this.query(statement);
    const settings = dataFusionSettingStatements(this.options);
    if (settings) {
      await this.query(settings);
    }
  }
}

export function dataFusionSettingStatements(
  options: DataFusionSettingOptions,
): string {
  const settings: [string, string | number | boolean | undefined][] = [
    [
      "distributed.file_scan_config_bytes_per_partition",
      options.fileScanConfigBytesPerPartition,
    ],
    ["distributed.cardinality_task_count_factor", options.cardinalityTaskSf],
    ["datafusion.execution.batch_size", options.batchSize],
    ["distributed.shuffle_batch_size", options.shuffleBatchSize],
    ["distributed.collect_metrics", options.collectMetrics],
    ["distributed.compression", options.compression],
    ["distributed.children_isolator_unions", options.childrenIsolatorUnions],
    ["distributed.broadcast_joins", options.broadcastJoins],
    ["distributed.partial_reduce", options.partialReduce],
    ["distributed.dynamic_task_count", options.dynamic],
    [
      "distributed.dynamic_bytes_per_partition",
      options.dynamicBytesPerPartition,
    ],
    ["distributed.max_tasks_per_stage", options.maxTasksPerStage],
    [
      "datafusion.optimizer.repartition_file_min_size",
      options.repartitionFileMinSize,
    ],
    ["datafusion.execution.target_partitions", options.targetPartitions],
  ];
  return settings
    .flatMap(([name, value]) =>
      value === undefined ? [] : [`SET ${name}=${value};`],
    )
    .join("\n");
}

if (require.main === module) {
  const options = runSync(DataFusionOptions, {
    help: "option",
    showDefault: true,
  });
  void runEngineBenchmark(new DataFusionRunner(options));
}
