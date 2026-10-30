import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  datafusionDistributedRoot,
  DEFAULT_DATAFUSION_DISTRIBUTED_ROOT,
  DEV_TOOLS_ROOT,
  datasetParts,
  datasetPath,
  datasetSuite,
  resolveDatasetAlias,
} from "../src/lib/paths";

test("uses the sibling DataFusion Distributed checkout for testdata", () => {
  assert.equal(
    DEFAULT_DATAFUSION_DISTRIBUTED_ROOT,
    path.resolve(DEV_TOOLS_ROOT, "../datafusion-distributed"),
  );
});

test("rejects dataset path dot components", () => {
  for (const dataset of ["../..", "./sf1", "tpch/.."]) {
    assert.throws(() => datasetParts(dataset), /Invalid dataset/);
  }
});

test("rejects dataset paths with fewer than two components", () => {
  assert.throws(() => datasetParts("tpch"), /Invalid dataset/);
});

test("derives the query suite from a parameter-encoded dataset path", () => {
  assert.equal(
    datasetSuite(
      "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false",
    ),
    "tpch",
  );
  assert.equal(
    datasetSuite(
      "tpch_iceberg/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false/target_file_size=67108864",
    ),
    "tpch",
  );
  assert.equal(
    datasetSuite("clickbench_parquet/partition_start=0/partition_end=100"),
    "clickbench",
  );
});

test("resolves pre-parameter-encoded dataset aliases", () => {
  assert.equal(
    resolveDatasetAlias("tpch/sf100"),
    "tpch_parquet/scale_factor=100/max_file_size=134217728/dictionary=pages/sorted=false",
  );
  assert.equal(
    resolveDatasetAlias("tpcds/sf1"),
    "tpcds_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false",
  );
  assert.equal(
    resolveDatasetAlias("clickbench/0-100"),
    "clickbench_parquet/partition_start=0/partition_end=100",
  );
  assert.equal(
    resolveDatasetAlias(
      "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false",
    ),
    "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false",
  );
  assert.equal(resolveDatasetAlias("unknown/dataset"), "unknown/dataset");
});

test("allows a source worktree to override the sibling checkout", () => {
  const previous = process.env.DATAFUSION_DISTRIBUTED_ROOT;
  process.env.DATAFUSION_DISTRIBUTED_ROOT = "../datafusion-distributed-pr";
  try {
    const sourceRoot = path.resolve(
      DEV_TOOLS_ROOT,
      "../datafusion-distributed-pr",
    );
    assert.equal(datafusionDistributedRoot(), sourceRoot);
  } finally {
    if (previous === undefined) {
      delete process.env.DATAFUSION_DISTRIBUTED_ROOT;
    } else {
      process.env.DATAFUSION_DISTRIBUTED_ROOT = previous;
    }
  }
});

test("resolves result paths without requiring a local dataset", () => {
  assert.equal(
    datasetPath("tpch/sf1", "/benchmark-testdata"),
    "/benchmark-testdata/tpch/sf1",
  );
});
