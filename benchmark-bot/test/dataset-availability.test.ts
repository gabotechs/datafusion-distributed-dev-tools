import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listAvailableDatasets } from "../src/dataset-availability.js";
import type { ProcessRunner, RunOptions, RunResult } from "../src/process.js";

function outputsFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), "dataset-availability-"));
  const file = path.join(root, "outputs.json");
  writeFileSync(
    file,
    JSON.stringify({
      clusterName: "cluster",
      datasetBucketName: "bucket",
      artifactBucketName: "artifacts",
    }),
  );
  return file;
}

test("lists dataset paths by their _SUCCESS marker", async () => {
  let capturedArguments: readonly string[] | undefined;
  const processes: ProcessRunner = {
    async run(
      program: string,
      arguments_: readonly string[],
      _options?: RunOptions,
    ): Promise<RunResult> {
      assert.equal(program, "aws");
      capturedArguments = arguments_;
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          "tpch_parquet/scale_factor=10/max_file_size=134217728/dictionary=pages/sorted=false/_SUCCESS",
          "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false/_SUCCESS",
          "clickbench_parquet/partition_start=0/partition_end=100/_SUCCESS",
        ]),
        stderr: "",
      };
    },
  };

  const datasets = await listAvailableDatasets(processes, {
    foundationOutputsFile: outputsFile(),
    region: "us-east-1",
  });

  assert.deepEqual(datasets, [
    "clickbench_parquet/partition_start=0/partition_end=100",
    "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false",
    "tpch_parquet/scale_factor=10/max_file_size=134217728/dictionary=pages/sorted=false",
  ]);
  assert.deepEqual(capturedArguments, [
    "--region",
    "us-east-1",
    "s3api",
    "list-objects-v2",
    "--bucket",
    "bucket",
    "--query",
    "Contents[?ends_with(Key, '_SUCCESS')].Key",
    "--output",
    "json",
  ]);
});

test("returns no datasets when the bucket has nothing generated", async () => {
  const processes: ProcessRunner = {
    async run(): Promise<RunResult> {
      return { exitCode: 0, stdout: "[]", stderr: "" };
    },
  };

  const datasets = await listAvailableDatasets(processes, {
    foundationOutputsFile: outputsFile(),
    region: "us-east-1",
  });

  assert.deepEqual(datasets, []);
});

test("rejects a non-array response from the dataset listing", async () => {
  const processes: ProcessRunner = {
    async run(): Promise<RunResult> {
      return { exitCode: 0, stdout: "null", stderr: "" };
    },
  };

  await assert.rejects(
    listAvailableDatasets(processes, {
      foundationOutputsFile: outputsFile(),
      region: "us-east-1",
    }),
    /Invalid dataset listing for bucket bucket/,
  );
});
