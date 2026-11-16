import assert from "node:assert/strict";
import test from "node:test";

import { parseSync } from "@optique/core";

import { CommonOptions, queryArguments } from "../src/lib/engine-cli";

function parsedQueries(args: string[]): string[] {
  const result = parseSync(CommonOptions, [
    "tpch/sf1",
    "--bucket",
    "s3://bucket",
    "--k8s-cluster",
    "cluster",
    ...args,
  ]);
  assert.ok(result.success, "arguments should parse");
  return queryArguments(result.value.queries);
}

test("runs every query when no query is selected", () => {
  assert.deepEqual(parsedQueries([]), []);
});

test("accepts -q, --query and --queries, repeated or comma-separated", () => {
  assert.deepEqual(
    parsedQueries(["-q", "q1", "--query", "q8", "--queries", "q6, q21"]),
    ["q1", "q8", "q6", "q21"],
  );
});

test("rejects an empty query selection", () => {
  assert.throws(() => parsedQueries(["-q", ","]), /at least one query ID/);
});
