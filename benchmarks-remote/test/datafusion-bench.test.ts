import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import {
  configEntries,
  dataFusionSettingStatements,
} from "../src/bin/datafusion-bench";

function tempDirectory(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "df-bench-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("collects metrics by default, overridable by any config", () => {
  assert.equal(
    dataFusionSettingStatements([]),
    "SET distributed.collect_metrics=true;",
  );
  assert.deepEqual(
    dataFusionSettingStatements([
      ["distributed.collect_metrics", "false"],
      ["datafusion.execution.target_partitions", "8"],
    ]).split("\n"),
    [
      "SET distributed.collect_metrics=true;",
      "SET distributed.collect_metrics=false;",
      "SET datafusion.execution.target_partitions=8;",
    ],
  );
});

test("rejects unsafe config keys and values", () => {
  assert.throws(
    () => dataFusionSettingStatements([["x", "1;DROP TABLE y"]]),
    /expected a safe token/,
  );
  assert.throws(
    () => dataFusionSettingStatements([["x;DROP", "1"]]),
    /Invalid config key/,
  );
  assert.throws(
    () => configEntries({ configs: ["distributed.broadcast_joins"] }, "/"),
    /expected KEY=VALUE/,
  );
});

test("reads .df-bench.yaml from the current directory before -c flags", (t) => {
  const directory = tempDirectory(t);
  assert.deepEqual(configEntries({ configs: [] }, directory), []);
  fs.writeFileSync(
    path.join(directory, ".df-bench.yaml"),
    [
      "# Local benchmark config",
      "distributed.broadcast_joins: true",
      "datafusion.execution.target_partitions: 10",
      "distributed.dynamic_bytes_ready_sample_percentage: 0.5",
      "distributed.compression: zstd",
    ].join("\n"),
  );
  assert.deepEqual(
    configEntries(
      { configs: ["datafusion.execution.target_partitions = 4"] },
      directory,
    ),
    [
      ["distributed.broadcast_joins", "true"],
      ["datafusion.execution.target_partitions", "10"],
      ["distributed.dynamic_bytes_ready_sample_percentage", "0.5"],
      ["distributed.compression", "zstd"],
      ["datafusion.execution.target_partitions", "4"],
    ],
  );
});

test("reads --config-path instead of the default file", (t) => {
  const directory = tempDirectory(t);
  fs.writeFileSync(path.join(directory, ".df-bench.yaml"), "a.b: 1");
  fs.writeFileSync(path.join(directory, "other.yaml"), "# only comments\n");
  assert.deepEqual(
    configEntries({ configPath: "other.yaml", configs: [] }, directory),
    [],
  );
  assert.throws(
    () => configEntries({ configPath: "missing.yaml", configs: [] }, directory),
    /Cannot read/,
  );
  fs.writeFileSync(path.join(directory, "nested.yaml"), "a:\n  b: 1\n");
  assert.throws(
    () => configEntries({ configPath: "nested.yaml", configs: [] }, directory),
    /must be a scalar/,
  );
  fs.writeFileSync(path.join(directory, "list.yaml"), "- a\n");
  assert.throws(
    () => configEntries({ configPath: "list.yaml", configs: [] }, directory),
    /flat key: value pairs/,
  );
});

test("registers Iceberg metadata and Parquet directories with the worker", async (t) => {
  const { createServer } = await import("node:http");
  const { DataFusionRunner } = await import("../src/bin/datafusion-bench");
  const statements: string[] = [];
  const server = createServer((request, response) => {
    statements.push(
      new URL(request.url!, "http://localhost").searchParams.get("sql")!,
    );
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
  const configPath = path.join(tempDirectory(t), "config.yaml");
  fs.writeFileSync(configPath, "distributed.broadcast_joins: true\n");
  const runner = new DataFusionRunner({
    url: `http://127.0.0.1:${address.port}`,
    configPath,
    configs: ["distributed.dynamic_task_count=true"],
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
  const [sql, settings] = statements;
  assert.match(
    sql!,
    /orders STORED AS PARQUET LOCATION 's3:\/\/bucket\/tpch\/sf1\/orders\/'/,
  );
  assert.match(
    sql!,
    /lineitem STORED AS ICEBERG LOCATION 's3:\/\/bucket\/tpch\/sf1_iceberg\/lineitem\/metadata.json'/,
  );
  assert.deepEqual(settings!.split("\n"), [
    "SET distributed.collect_metrics=true;",
    "SET distributed.broadcast_joins=true;",
    "SET distributed.dynamic_task_count=true;",
  ]);
});

test("discovers Iceberg table metadata in S3 and reuses the suite queries", async (t) => {
  const { tablePathsForDataset, queriesForDataset } =
    await import("../src/lib/engine-cli");
  const dataset =
    "tpch_iceberg/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false/target_file_size=67108864";
  const schema = dataset.replace(/[^a-zA-Z0-9_]+/g, "_");
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
      command.input.Prefix === `prefix/${dataset}/`
        ? { CommonPrefixes: [{ Prefix: `prefix/${dataset}/lineitem/` }] }
        : {
            Contents: [{ Key: `prefix/${dataset}/lineitem/metadata.json` }],
          },
  );
  assert.deepEqual(
    await tablePathsForDataset(dataset, "s3://bucket/prefix", "us-east-1"),
    [
      {
        suite: "tpch",
        schema,
        name: "lineitem",
        fileType: "ICEBERG",
        s3Path: `s3://bucket/prefix/${dataset}/lineitem/metadata.json`,
      },
    ],
  );
  assert.deepEqual(await queriesForDataset(dataset, root), [
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
    "datafusion-alice-example",
  );
  assert.equal(
    dataFusionServiceName({ USER: "alice.example", DEPLOYMENT_NAME: "" }),
    "datafusion-alice-example",
  );
});
