import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  datafusionDistributedRoot,
  DEFAULT_DATAFUSION_DISTRIBUTED_ROOT,
  DEV_TOOLS_ROOT,
  datasetParts,
  datasetPath,
  testdataRoots,
} from "../src/lib/paths";

test("uses the sibling DataFusion Distributed checkout for testdata", () => {
  assert.equal(
    DEFAULT_DATAFUSION_DISTRIBUTED_ROOT,
    path.resolve(DEV_TOOLS_ROOT, "../datafusion-distributed"),
  );
  assert.deepEqual(testdataRoots(), [
    path.join(DEFAULT_DATAFUSION_DISTRIBUTED_ROOT, "testdata"),
  ]);
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
    assert.deepEqual(testdataRoots(), [path.join(sourceRoot, "testdata")]);
  } finally {
    if (previous === undefined) {
      delete process.env.DATAFUSION_DISTRIBUTED_ROOT;
    } else {
      process.env.DATAFUSION_DISTRIBUTED_ROOT = previous;
    }
  }
});

test("reports every searched location when a dataset is absent", () => {
  assert.throws(
    () => datasetPath("tpch/sf1", "/missing-benchmark-testdata"),
    /Dataset 'tpch\/sf1' was not found\. Looked in: \/missing-benchmark-testdata\/tpch\/sf1/,
  );
});
