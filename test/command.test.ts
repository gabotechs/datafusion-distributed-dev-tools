import assert from "node:assert/strict";
import test from "node:test";

import { parseComment } from "../src/command.js";

test("parses the requested dataset", () => {
  assert.deepEqual(parseComment("benchmarks run tpch/sf1"), {
    kind: "request",
    request: { dataset: "tpch/sf1" },
  });
});

test("ignores unrelated comments", () => {
  assert.deepEqual(parseComment("looks good"), { kind: "none" });
});

test("rejects aliases and extra arguments", () => {
  assert.deepEqual(parseComment("benchmarks run tpch_sf1"), {
    kind: "invalid",
    message: "Invalid dataset `tpch_sf1`; expected a path such as `tpch/sf1`.",
  });
  assert.deepEqual(parseComment("benchmarks run tpch/sf1 now"), {
    kind: "invalid",
    message: "Expected `benchmarks run <suite>/<variant>`.",
  });
});
