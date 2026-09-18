import assert from "node:assert/strict";
import test from "node:test";
import { S3Client, type ListObjectsV2Command } from "@aws-sdk/client-s3";

import { discoverDatasetTables } from "../src/lib/dataset-formats";
import { readS3Directory } from "../src/lib/engine-cli";

test("discovers Parquet and Iceberg tables in paginated S3 listings", async (t) => {
  const client = new S3Client({ region: "us-east-1" });
  t.after(() => client.destroy());
  const calls: unknown[] = [];
  t.mock.method(client, "send", async (command: ListObjectsV2Command) => {
    calls.push(command.input);
    const pages = new Map([
      [
        "prefix/",
        {
          CommonPrefixes: [{ Prefix: "prefix/orders/" }],
          NextContinuationToken: "page2",
        },
      ],
      ["page2", { CommonPrefixes: [{ Prefix: "prefix/lineitem/" }] }],
      ["prefix/orders/", { Contents: [{ Key: "prefix/orders/part.parquet" }] }],
      [
        "prefix/lineitem/",
        {
          Contents: [{ Key: "prefix/lineitem/metadata.json" }],
          CommonPrefixes: [{ Prefix: "prefix/lineitem/metadata/" }],
        },
      ],
    ]);
    return pages.get(command.input.ContinuationToken ?? command.input.Prefix!);
  });
  const remote = await discoverDatasetTables(
    "prefix",
    readS3Directory(client, "bucket"),
  );
  const describe = (tables: typeof remote) =>
    tables
      .map(({ name, format }) => ({
        name,
        fileType: format.fileType,
        entryPoint: format.entryPoint,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(describe(remote), [
    { name: "lineitem", fileType: "ICEBERG", entryPoint: "metadata.json" },
    { name: "orders", fileType: "PARQUET", entryPoint: "" },
  ]);
  assert.equal(calls.length, 4);
});
