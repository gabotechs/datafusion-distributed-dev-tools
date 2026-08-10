import assert from "node:assert/strict";
import test from "node:test";

import { trinoStatementResponseSchema } from "../src/bin/trino-bench";

test("validates Trino statement response pages", () => {
  assert.deepEqual(
    trinoStatementResponseSchema.parse({
      nextUri: "http://localhost:9000/v1/statement/1",
      data: [["plan"]],
      stats: { elapsedTimeMillis: 42, state: "FINISHED" },
    }),
    {
      nextUri: "http://localhost:9000/v1/statement/1",
      data: [["plan"]],
      stats: { elapsedTimeMillis: 42, state: "FINISHED" },
    },
  );
  assert.throws(() =>
    trinoStatementResponseSchema.parse({ stats: { elapsedTimeMillis: "42" } }),
  );
});
