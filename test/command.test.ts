import assert from "node:assert/strict";
import test from "node:test";

import { parseComment } from "../src/command.js";

test("parses the requested dataset and capacity", () => {
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --instance-type c7i.2xlarge --nodes 12",
    ),
    {
      kind: "request",
      request: {
        dataset: "tpch/sf1",
        instanceType: "c7i.2xlarge",
        nodeCount: 12,
      },
    },
  );
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --nodes 12 --instance-type c7i.2xlarge",
    ),
    {
      kind: "request",
      request: {
        dataset: "tpch/sf1",
        instanceType: "c7i.2xlarge",
        nodeCount: 12,
      },
    },
  );
});

test("requires and sanitizes benchmark capacity", () => {
  assert.deepEqual(parseComment("benchmarks run tpch/sf1"), {
    kind: "invalid",
    message:
      "Expected `benchmarks run <suite>/<variant> --instance-type <type> --nodes <count>`.",
  });
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --instance-type c7i.2xlarge --nodes 25",
    ),
    {
      kind: "invalid",
      message: "Invalid node count `25`; expected an integer from 1 to 24.",
    },
  );
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --instance-type $(whoami) --nodes 12",
    ),
    {
      kind: "invalid",
      message: "Invalid instance type `$(whoami)`.",
    },
  );
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --instance-type c7i.2xlarge --nodes 1.5",
    ),
    {
      kind: "invalid",
      message: "Invalid node count `1.5`; expected an integer from 1 to 24.",
    },
  );
});

test("ignores unrelated comments", () => {
  assert.deepEqual(parseComment("looks good"), { kind: "none" });
});

test("rejects aliases and extra arguments", () => {
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch_sf1 --instance-type c7i.2xlarge --nodes 12",
    ),
    {
      kind: "invalid",
      message:
        "Invalid dataset `tpch_sf1`; expected a path such as `tpch/sf1`.",
    },
  );
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --instance-type c7i.2xlarge --nodes 12 now",
    ),
    {
      kind: "invalid",
      message:
        "Expected `benchmarks run <suite>/<variant> --instance-type <type> --nodes <count>`.",
    },
  );
});
