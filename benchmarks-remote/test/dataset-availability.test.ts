import assert from "node:assert/strict";
import test from "node:test";

import { type ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { listAvailableDatasets } from "../src/lib/dataset-availability";

test("lists dataset paths by their _SUCCESS marker across pages", async (t) => {
  const client = new S3Client({ region: "us-east-1" });
  t.after(() => client.destroy());
  t.mock.method(client, "send", async (command: ListObjectsV2Command) => {
    if (command.input.ContinuationToken === undefined) {
      return {
        Contents: [
          {
            Key: "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false/lineitem/1.parquet",
          },
          {
            Key: "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false/_SUCCESS",
          },
        ],
        NextContinuationToken: "page2",
      };
    }
    return {
      Contents: [
        {
          Key: "clickbench_parquet/partition_start=0/partition_end=100/_SUCCESS",
        },
      ],
    };
  });

  const datasets = await listAvailableDatasets(client, "bucket");

  assert.deepEqual(datasets, [
    "clickbench_parquet/partition_start=0/partition_end=100",
    "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false",
  ]);
});

test("strips a bucket prefix from the returned dataset paths", async (t) => {
  const client = new S3Client({ region: "us-east-1" });
  t.after(() => client.destroy());
  t.mock.method(client, "send", async (command: ListObjectsV2Command) => {
    assert.equal(command.input.Prefix, "datasets/");
    return {
      Contents: [
        {
          Key: "datasets/clickbench_parquet/partition_start=0/partition_end=100/_SUCCESS",
        },
      ],
    };
  });

  const datasets = await listAvailableDatasets(client, "bucket", "datasets/");

  assert.deepEqual(datasets, [
    "clickbench_parquet/partition_start=0/partition_end=100",
  ]);
});

test("returns no datasets when nothing has finished generating", async (t) => {
  const client = new S3Client({ region: "us-east-1" });
  t.after(() => client.destroy());
  t.mock.method(client, "send", async () => ({}));

  assert.deepEqual(await listAvailableDatasets(client, "bucket"), []);
});
