import assert from "node:assert/strict";
import test from "node:test";
import { validateDatasetNames } from "../src/lib/datasets";

test("requires safe dataset prefixes for deletion", () => {
  assert.deepEqual(
    validateDatasetNames(["tpch/sf1", "clickbench/0-100", "tpch/sf1"]),
    ["tpch/sf1", "clickbench/0-100"],
  );
  assert.throws(
    () => validateDatasetNames([".benchmark-artifacts"]),
    /Invalid dataset/,
  );
  assert.throws(
    () => validateDatasetNames(["tpch/sf1\/../"]),
    /Invalid dataset/,
  );
});
