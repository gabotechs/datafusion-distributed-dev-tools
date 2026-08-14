import assert from "node:assert/strict";
import test from "node:test";

import { dataFusionSettingStatements } from "../src/bin/datafusion-bench";

test("does not override DataFusion defaults when flags are omitted", () => {
  assert.equal(dataFusionSettingStatements({}), "");
});

test("sets only explicitly provided DataFusion options", () => {
  assert.equal(
    dataFusionSettingStatements({
      dynamic: false,
      maxTasksPerStage: 0,
      compression: "zstd",
    }),
    [
      "SET distributed.compression=zstd;",
      "SET distributed.dynamic_task_count=false;",
      "SET distributed.max_tasks_per_stage=0;",
    ].join("\n"),
  );
});

test("maps every DataFusion override to its session setting", () => {
  assert.deepEqual(
    dataFusionSettingStatements({
      fileScanConfigBytesPerPartition: 1,
      cardinalityTaskSf: 2,
      batchSize: 3,
      shuffleBatchSize: 4,
      collectMetrics: true,
      compression: "lz4",
      childrenIsolatorUnions: false,
      broadcastJoins: true,
      partialReduce: false,
      dynamic: true,
      dynamicBytesPerPartition: 5,
      maxTasksPerStage: 6,
      repartitionFileMinSize: 7,
      targetPartitions: 8,
    }).split("\n"),
    [
      "SET distributed.file_scan_config_bytes_per_partition=1;",
      "SET distributed.cardinality_task_count_factor=2;",
      "SET datafusion.execution.batch_size=3;",
      "SET distributed.shuffle_batch_size=4;",
      "SET distributed.collect_metrics=true;",
      "SET distributed.compression=lz4;",
      "SET distributed.children_isolator_unions=false;",
      "SET distributed.broadcast_joins=true;",
      "SET distributed.partial_reduce=false;",
      "SET distributed.dynamic_task_count=true;",
      "SET distributed.dynamic_bytes_per_partition=5;",
      "SET distributed.max_tasks_per_stage=6;",
      "SET datafusion.optimizer.repartition_file_min_size=7;",
      "SET datafusion.execution.target_partitions=8;",
    ],
  );
});
