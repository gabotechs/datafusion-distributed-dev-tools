import assert from "node:assert/strict";
import test from "node:test";

import { parseComment } from "../src/command.js";

test("parses the requested dataset and capacity", () => {
  assert.deepEqual(parseComment("benchmarks run tpch/sf1"), {
    kind: "request",
    request: {
      datasets: ["tpch/sf1"],
      instanceType: "c5n.2xlarge",
      nodeCount: 12,
    },
  });
  assert.deepEqual(
    parseComment("benchmarks run tpch/sf1 tpch/sf10 tpch/sf100 --nodes 6"),
    {
      kind: "request",
      request: {
        datasets: ["tpch/sf1", "tpch/sf10", "tpch/sf100"],
        instanceType: "c5n.2xlarge",
        nodeCount: 6,
      },
    },
  );
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --instance-type c7i.2xlarge --nodes 12",
    ),
    {
      kind: "request",
      request: {
        datasets: ["tpch/sf1"],
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
        datasets: ["tpch/sf1"],
        instanceType: "c7i.2xlarge",
        nodeCount: 12,
      },
    },
  );
  assert.deepEqual(parseComment("benchmarks run tpch/sf1 --nodes 4"), {
    kind: "request",
    request: {
      datasets: ["tpch/sf1"],
      instanceType: "c5n.2xlarge",
      nodeCount: 4,
    },
  });
  assert.deepEqual(
    parseComment("benchmarks run tpch/sf1 --instance-type c7i.2xlarge"),
    {
      kind: "request",
      request: {
        datasets: ["tpch/sf1"],
        instanceType: "c7i.2xlarge",
        nodeCount: 12,
      },
    },
  );
});

test("accepts repeatable head-only configs", () => {
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --base main --config distributed.collect_dynamic_filters=false --config distributed.max_tasks_per_stage=8",
    ),
    {
      kind: "request",
      request: {
        datasets: ["tpch/sf1"],
        instanceType: "c5n.2xlarge",
        nodeCount: 12,
        base: "main",
        configs: [
          "distributed.collect_dynamic_filters=false",
          "distributed.max_tasks_per_stage=8",
        ],
      },
    },
  );
});

test("rejects unsafe or duplicate configs", () => {
  assert.deepEqual(parseComment("benchmarks run tpch/sf1 --config x=1;DROP"), {
    kind: "invalid",
    message: "Invalid config `x=1;DROP`; expected a safe `key=value` token.",
  });
  assert.deepEqual(
    parseComment("benchmarks run tpch/sf1 --config x=1 --config x=2"),
    {
      kind: "invalid",
      message: "Config `x` may be specified only once.",
    },
  );
});

test("sanitizes benchmark capacity", () => {
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

test("accepts only main as an explicit comparison base", () => {
  assert.deepEqual(parseComment("benchmarks run tpch/sf100 --base main"), {
    kind: "request",
    request: {
      datasets: ["tpch/sf100"],
      instanceType: "c5n.2xlarge",
      nodeCount: 12,
      base: "main",
    },
  });
  assert.deepEqual(parseComment("benchmarks run tpch/sf100 --base release-3"), {
    kind: "invalid",
    message: "Invalid base `release-3`; only `main` is supported.",
  });
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
        "Expected `benchmarks run <suite>/<variant>... [--instance-type <type>] [--nodes <count>] [--base main] [--config <key=value>]...`.",
    },
  );
  assert.deepEqual(parseComment("benchmarks run tpch/sf1 tpch/sf1"), {
    kind: "invalid",
    message: "Each dataset may be requested only once.",
  });
});
