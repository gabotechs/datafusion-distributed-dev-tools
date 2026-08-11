import { z } from "zod";

import {
  merge,
  message,
  object,
  option,
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
import type { ExecuteQueryResult, TableSpec } from "../lib/runner";
import { splitViewQuery, type BenchmarkRunner } from "../lib/runner";

const Options = object({
  engine: option("--engine", string({ metavar: "NAME" }), {
    description: message`Engine name used to store benchmark results`,
  }),
  fileScanConfigBytesPerPartition: withDefault(
    option("--file-scan-config-bytes-per-partition", integerValue, {
      description: message`Bytes each partition scans`,
    }),
    16_777_216,
  ),
  cardinalityTaskSf: withDefault(
    option("--cardinality-task-sf", numberValue, {
      description: message`Cardinality task scale factor`,
    }),
    1,
  ),
  batchSize: withDefault(
    option("--batch-size", integerValue, {
      description: message`Standard batch coalescing size`,
    }),
    32_768,
  ),
  shuffleBatchSize: withDefault(
    option("--shuffle-batch-size", integerValue, {
      description: message`Worker RepartitionExec batch size`,
    }),
    0,
  ),
  childrenIsolatorUnions: withDefault(
    option("--children-isolator-unions", booleanValue, {
      description: message`Use children isolator unions`,
    }),
    true,
  ),
  broadcastJoins: withDefault(
    option("--broadcast-joins", booleanValue, {
      description: message`Use broadcast joins`,
    }),
    true,
  ),
  partialReduce: withDefault(
    option("--partial-reduce", booleanValue, {
      description: message`Enable PartialReduce optimization`,
    }),
    false,
  ),
  collectMetrics: withDefault(
    option("--collect-metrics", booleanValue, {
      description: message`Propagate metric collection`,
    }),
    true,
  ),
  compression: withDefault(
    option("--compression", string({ metavar: "CODEC" }), {
      description: message`Worker compression codec`,
    }),
    "lz4",
  ),
  maxTasksPerStage: withDefault(
    option("--max-tasks-per-stage", integerValue, {
      description: message`Maximum tasks per stage`,
    }),
    0,
  ),
  repartitionFileMinSize: withDefault(
    option("--repartition-file-min-size", integerValue, {
      description: message`DataFusion repartition file minimum size`,
    }),
    10_485_760,
  ),
  targetPartitions: withDefault(
    option("--target-partitions", integerValue, {
      description: message`DataFusion target partition count`,
    }),
    8,
  ),
  dynamic: withDefault(
    option("--dynamic", booleanValue, {
      description: message`Use dynamic task count assignment`,
    }),
    false,
  ),
  dynamicBytesPerPartition: withDefault(
    option("--dynamic-bytes-per-partition", integerValue, {
      description: message`Dynamic allocation bytes per partition`,
    }),
    16 * 1024 * 1024,
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

export class DataFusionRunner implements BenchmarkRunner {
  readonly engine: string;

  constructor(public readonly options: DataFusionOptions) {
    this.engine = options.engine;
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
    await this.query(`
      SET distributed.file_scan_config_bytes_per_partition=${this.options.fileScanConfigBytesPerPartition};
      SET distributed.cardinality_task_count_factor=${this.options.cardinalityTaskSf};
      SET datafusion.execution.batch_size=${this.options.batchSize};
      SET distributed.shuffle_batch_size=${this.options.shuffleBatchSize};
      SET distributed.collect_metrics=${this.options.collectMetrics};
      SET distributed.compression=${this.options.compression};
      SET distributed.children_isolator_unions=${this.options.childrenIsolatorUnions};
      SET distributed.broadcast_joins=${this.options.broadcastJoins};
      SET distributed.partial_reduce=${this.options.partialReduce};
      SET distributed.dynamic_task_count=${this.options.dynamic};
      SET distributed.dynamic_bytes_per_partition=${this.options.dynamicBytesPerPartition};
      SET distributed.max_tasks_per_stage=${this.options.maxTasksPerStage};
      SET datafusion.optimizer.repartition_file_min_size=${this.options.repartitionFileMinSize};
      SET datafusion.execution.target_partitions=${this.options.targetPartitions};
    `);
  }
}

if (require.main === module) {
  const options = runSync(DataFusionOptions, {
    help: "option",
    showDefault: true,
  });
  void runEngineBenchmark(new DataFusionRunner(options));
}
