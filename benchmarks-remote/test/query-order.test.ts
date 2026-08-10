import assert from "node:assert/strict";
import test from "node:test";

import { compareQueryIds } from "../src/lib/query-order";

test("orders numbered query IDs naturally and digit-less IDs deterministically", () => {
  const queryIds = ["custom", "q10", "beta", "q2", "alpha", "q1"];
  assert.deepEqual(queryIds.sort(compareQueryIds), [
    "q1",
    "q2",
    "q10",
    "alpha",
    "beta",
    "custom",
  ]);
});

test("uses names as a deterministic tie breaker for equal numeric IDs", () => {
  assert.deepEqual(["q1b", "q1a"].sort(compareQueryIds), ["q1a", "q1b"]);
});
