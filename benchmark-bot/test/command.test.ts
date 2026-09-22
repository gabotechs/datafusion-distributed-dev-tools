import assert from "node:assert/strict";
import test from "node:test";

import { parseComment } from "../src/command.js";

test("parses the requested dataset and capacity", () => {
  assert.deepEqual(parseComment("benchmarks run tpch/sf1"), {
    kind: "request",
    request: {
      datasets: ["tpch/sf1"],
      instanceType: "c5n.4xlarge",
      nodeCount: 12,
      iterations: 5,
    },
  });
  assert.deepEqual(
    parseComment("benchmarks run tpch/sf1 tpch/sf10 tpch/sf100 --nodes 6"),
    {
      kind: "request",
      request: {
        datasets: ["tpch/sf1", "tpch/sf10", "tpch/sf100"],
        instanceType: "c5n.4xlarge",
        nodeCount: 6,
        iterations: 5,
      },
    },
  );
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --instance-type m5.2xlarge --nodes 12",
    ),
    {
      kind: "request",
      request: {
        datasets: ["tpch/sf1"],
        instanceType: "m5.2xlarge",
        nodeCount: 12,
        iterations: 5,
      },
    },
  );
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --nodes 12 --instance-type m5.2xlarge",
    ),
    {
      kind: "request",
      request: {
        datasets: ["tpch/sf1"],
        instanceType: "m5.2xlarge",
        nodeCount: 12,
        iterations: 5,
      },
    },
  );
  assert.deepEqual(parseComment("benchmarks run tpch/sf1 --nodes 4"), {
    kind: "request",
    request: {
      datasets: ["tpch/sf1"],
      instanceType: "c5n.4xlarge",
      nodeCount: 4,
      iterations: 5,
    },
  });
  assert.deepEqual(
    parseComment("benchmarks run tpch/sf1 --instance-type m5.2xlarge"),
    {
      kind: "request",
      request: {
        datasets: ["tpch/sf1"],
        instanceType: "m5.2xlarge",
        nodeCount: 12,
        iterations: 5,
      },
    },
  );
});

test("accepts a measured iteration count with a main baseline", () => {
  for (const iterations of [1, 20, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(
      parseComment(
        `benchmarks run clickbench/0-100-date32 --base main --iterations ${iterations}`,
      ),
      {
        kind: "request",
        request: {
          datasets: ["clickbench/0-100-date32"],
          instanceType: "c5n.4xlarge",
          nodeCount: 12,
          iterations,
          base: "main",
        },
      },
    );
  }
});

test("rejects invalid, missing, and duplicate iteration counts", () => {
  for (const value of [
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "1e2",
    "0x10",
    "9007199254740992",
    "20;whoami",
  ]) {
    assert.deepEqual(
      parseComment(`benchmarks run tpch/sf1 --iterations ${value}`),
      {
        kind: "invalid",
        message: `Invalid iteration count \`${value}\`; expected a positive safe integer.`,
      },
    );
  }
  for (const options of ["--iterations", "--iterations 5 --iterations 20"]) {
    assert.equal(
      parseComment(`benchmarks run tpch/sf1 ${options}`).kind,
      "invalid",
    );
  }
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
        instanceType: "c5n.4xlarge",
        nodeCount: 12,
        iterations: 5,
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
      "benchmarks run tpch/sf1 --instance-type m5.2xlarge --nodes 60",
    ),
    {
      kind: "request",
      request: {
        datasets: ["tpch/sf1"],
        instanceType: "m5.2xlarge",
        nodeCount: 60,
        iterations: 5,
      },
    },
  );
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --instance-type m5.2xlarge --nodes 61",
    ),
    {
      kind: "invalid",
      message: "Invalid node count `61`; expected an integer from 1 to 60.",
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
    parseComment("benchmarks run tpch/sf1 --instance-type c7i.2xlarge"),
    {
      kind: "invalid",
      message:
        "Unsupported instance type `c7i.2xlarge`; expected one of `c5n.2xlarge`, `c5n.4xlarge`, `m5.2xlarge`, `m5.4xlarge`, `r5.2xlarge`, `r5.4xlarge`.",
    },
  );
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --instance-type m5.2xlarge --nodes 1.5",
    ),
    {
      kind: "invalid",
      message: "Invalid node count `1.5`; expected an integer from 1 to 60.",
    },
  );
});

test("accepts only main as an explicit comparison base", () => {
  assert.deepEqual(parseComment("benchmarks run tpch/sf100 --base main"), {
    kind: "request",
    request: {
      datasets: ["tpch/sf100"],
      instanceType: "c5n.4xlarge",
      nodeCount: 12,
      iterations: 5,
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
      "benchmarks run tpch_sf1 --instance-type m5.2xlarge --nodes 12",
    ),
    {
      kind: "invalid",
      message:
        "Invalid dataset `tpch_sf1`; expected a path such as `tpch/sf1`.",
    },
  );
  assert.deepEqual(
    parseComment(
      "benchmarks run tpch/sf1 --instance-type m5.2xlarge --nodes 12 now",
    ),
    {
      kind: "invalid",
      message:
        "Expected `benchmarks run <suite>/<variant>... [--instance-type <type>] [--nodes <count>] [--iterations <count>] [--base main] [--config <key=value>]...`.",
    },
  );
  assert.deepEqual(parseComment("benchmarks run tpch/sf1 tpch/sf1"), {
    kind: "invalid",
    message: "Each dataset may be requested only once.",
  });
});
