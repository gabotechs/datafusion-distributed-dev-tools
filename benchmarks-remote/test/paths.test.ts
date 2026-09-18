import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  datafusionDistributedRoot,
  DEFAULT_DATAFUSION_DISTRIBUTED_ROOT,
  DEV_TOOLS_ROOT,
  datasetParts,
  datasetPath,
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
