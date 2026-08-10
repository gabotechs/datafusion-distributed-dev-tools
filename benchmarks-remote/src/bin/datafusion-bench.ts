import { z } from "zod";

import {
  booleanArgument,
  integerArgument,
  numberArgument,
  runEngineBenchmark,
} from "../lib/engine-cli";
import { datafusionDistributedGitReference } from "../lib/git-reference";
import type { ExecuteQueryResult, TableSpec } from "../lib/runner";
import { splitViewQuery, type BenchmarkRunner } from "../lib/runner";

interface DataFusionOptions {
  fileScanConfigBytesPerPartition: number;
  cardinalityTaskSf: number;
  batchSize: number;
  shuffleBatchSize: number;
  childrenIsolatorUnions: boolean;
  broadcastJoins: boolean;
  partialReduce: boolean;
  collectMetrics: boolean;
  compression: string;
  maxTasksPerStage: number;
  repartitionFileMinSize: number;
  targetPartitions: number;
  dynamic: boolean;
  dynamicBytesPerPartition: number;
}

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
  private readonly url = process.env.DATAFUSION_URL ?? "http://localhost:9000";

  constructor(private readonly options: DataFusionOptions) {}

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
    const url = new URL(this.url);
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
  runEngineBenchmark<DataFusionOptions>({
    engine: () =>
      `datafusion-distributed-${datafusionDistributedGitReference()}`,
    addOptions(command) {
      command
        .option(
          "--file-scan-config-bytes-per-partition <number>",
          "Bytes each partition scans",
          integerArgument,
          16_777_216,
        )
        .option(
          "--cardinality-task-sf <number>",
          "Cardinality task scale factor",
          numberArgument,
          1,
        )
        .option(
          "--batch-size <number>",
          "Standard Batch coalescing size (number of rows)",
          integerArgument,
          32_768,
        )
        .option(
          "--shuffle-batch-size <number>",
          "Override RepartitionExec batch size on worker stages (0 = no override)",
          integerArgument,
          0,
        )
        .option(
          "--children-isolator-unions <boolean>",
          "Use children isolator unions",
          booleanArgument,
          true,
        )
        .option(
          "--broadcast-joins <boolean>",
          "Use broadcast joins",
          booleanArgument,
          true,
        )
        .option(
          "--partial-reduce <boolean>",
          "Enable PartialReduce optimization",
          booleanArgument,
          false,
        )
        .option(
          "--collect-metrics <boolean>",
          "Propagate metric collection",
          booleanArgument,
          true,
        )
        .option(
          "--compression <string>",
          "Compression within workers (lz4, zstd, none)",
          "lz4",
        )
        .option(
          "--max-tasks-per-stage <number>",
          "Maximum tasks per stage",
          integerArgument,
          0,
        )
        .option(
          "--repartition-file-min-size <number>",
          "DataFusion repartition_file_min_size option",
          integerArgument,
          10_485_760,
        )
        .option(
          "--target-partitions <number>",
          "DataFusion target_partitions option",
          integerArgument,
          8,
        )
        .option(
          "--dynamic <boolean>",
          "Use the dynamic task count assigner",
          booleanArgument,
          false,
        )
        .option(
          "--dynamic-bytes-per-partition <number>",
          "Target bytes per partition per second for dynamic task allocation",
          integerArgument,
          16 * 1024 * 1024,
        );
    },
    createRunner: (options) => new DataFusionRunner(options),
  });
}
