import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

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

test("rejects unsafe or duplicate generic configs", () => {
  assert.throws(
    () => dataFusionSettingStatements({ configs: ["x=1;DROP TABLE y"] }),
    /expected a safe KEY=VALUE token/,
  );
  assert.throws(
    () => dataFusionSettingStatements({ configs: ["x=1", "x=2"] }),
    /Duplicate config 'x'/,
  );
});

test("maps every DataFusion override to its session setting", () => {
  assert.deepEqual(
    dataFusionSettingStatements({
      fileScanConfigBytesPerPartition: 1,
      cardinalityTaskSf: 2,
      batchSize: 3,
      shuffleBatchSize: 4,
      configs: ["distributed.collect_dynamic_filters=false"],
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
      "SET distributed.collect_dynamic_filters=false;",
    ],
  );
});

test("registers Iceberg metadata and Parquet directories with the worker", async (t) => {
  const { createServer } = await import("node:http");
  const { DataFusionRunner } = await import("../src/bin/datafusion-bench");
  let sql = "";
  const server = createServer((request, response) => {
    sql = new URL(request.url!, "http://localhost").searchParams.get("sql")!;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        count: 0,
        plan: "",
        elapsed_ms: 0,
        tasks: 0,
        stats_q_error_p50: null,
        stats_q_error_p95: null,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const runner = new DataFusionRunner({
    url: `http://127.0.0.1:${address.port}`,
    configs: [],
  } as unknown as ConstructorParameters<typeof DataFusionRunner>[0]);
  await runner.createTables([
    {
      suite: "tpch",
      schema: "tpch_sf1",
      name: "orders",
      fileType: "PARQUET",
      s3Path: "s3://bucket/tpch/sf1/orders/",
    },
    {
      suite: "tpch",
      schema: "tpch_sf1_iceberg",
      name: "lineitem",
      fileType: "ICEBERG",
      s3Path: "s3://bucket/tpch/sf1_iceberg/lineitem/metadata.json",
    },
  ]);
  assert.match(
    sql,
    /orders STORED AS PARQUET LOCATION 's3:\/\/bucket\/tpch\/sf1\/orders\/'/,
  );
  assert.match(
    sql,
    /lineitem STORED AS ICEBERG LOCATION 's3:\/\/bucket\/tpch\/sf1_iceberg\/lineitem\/metadata.json'/,
  );
});

test("discovers Iceberg table metadata in S3 and reuses the suite queries", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { tablePathsForDataset, queriesForDataset } =
    await import("../src/lib/engine-cli");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-tables-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "tpch/queries"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tpch/queries/q6.sql"),
    "SELECT count(*) FROM lineitem",
  );
  const { S3Client } = await import("@aws-sdk/client-s3");
  t.mock.method(
    S3Client.prototype,
    "send",
    async (command: { input: { Prefix: string } }) =>
      command.input.Prefix === "prefix/tpch/sf1_iceberg/"
        ? { CommonPrefixes: [{ Prefix: "prefix/tpch/sf1_iceberg/lineitem/" }] }
        : {
            Contents: [
              { Key: "prefix/tpch/sf1_iceberg/lineitem/metadata.json" },
            ],
          },
  );
  assert.deepEqual(
    await tablePathsForDataset(
      "tpch/sf1_iceberg",
      "s3://bucket/prefix",
      "us-east-1",
    ),
    [
      {
        suite: "tpch",
        schema: "tpch_sf1_iceberg",
        name: "lineitem",
        fileType: "ICEBERG",
        s3Path: "s3://bucket/prefix/tpch/sf1_iceberg/lineitem/metadata.json",
      },
    ],
  );
  assert.deepEqual(await queriesForDataset("tpch/sf1_iceberg", root), [
    { id: "q6", sql: "SELECT count(*) FROM lineitem" },
  ]);
});

test("defaults to the same named service as datafusion-deploy", async () => {
  const { dataFusionServiceName } = await import("../src/bin/datafusion-bench");
  assert.equal(
    dataFusionServiceName({ USER: "alice.example" }),
    "datafusion-alice-example",
  );
  assert.equal(
    dataFusionServiceName({
      USER: "alice.example",
      DEPLOYMENT_NAME: "custom-worker",
    }),
    "custom-worker",
  );
  assert.equal(
    dataFusionServiceName({ USER: "alice.example", DEPLOYMENT_NAME: "" }),
    "datafusion-alice-example",
  );
});
