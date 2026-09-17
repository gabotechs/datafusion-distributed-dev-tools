import assert from "node:assert/strict";
import test from "node:test";

import { BenchmarkRun, BenchResult } from "../src/lib/results";

function result(resultName: string, elapsed: number): BenchResult {
  const value = new BenchResult("tpch/sf1", resultName, "q1");
  value.iterations.push({
    elapsed,
    plan: "",
    rowCount: 1,
    tasks: 1,
  });
  return value;
}

test("highlights individual queries at 1.5x", () => {
  const normalRegression = result("head", 149).comparison(result("base", 100));
  const highlightedRegression = result("head", 150).comparison(
    result("base", 100),
  );
  const highlightedImprovement = result("head", 100).comparison(
    result("base", 150),
  );

  assert.match(normalRegression, /1\.49 slower ✖, tasks:/);
  assert.match(highlightedRegression, /1\.50 slower ❌, tasks:/);
  assert.match(highlightedImprovement, /1\.50 faster ✅, tasks:/);
});

test("highlights aggregate totals at 1.1x and prints TOTAL last", () => {
  const base = new BenchmarkRun("tpch/sf1", "base");
  base.results.push(result("base", 100));

  const normalHead = new BenchmarkRun("tpch/sf1", "head");
  normalHead.results.push(result("head", 109));
  const normal = normalHead.comparison(base).split("\n");

  const highlightedHead = new BenchmarkRun("tpch/sf1", "head");
  highlightedHead.results.push(result("head", 110));
  const highlighted = highlightedHead.comparison(base).split("\n");

  assert.match(normal.at(-1)!, /1\.09 slower ✖$/);
  assert.match(highlighted.at(-1)!, /1\.10 slower ❌$/);
  assert.match(highlighted[0]!, /^=== Comparing tpch\/sf1/);
  assert.match(highlighted.at(-1)!, /^\s*TOTAL:/);
});

test("appends the first head error to new and repeated failures on one line", () => {
  const base = result("base", 100);
  const head = result("head", 100);
  head.iterations.push(
    {
      elapsed: 0,
      plan: "",
      rowCount: 0,
      tasks: 0,
      error:
        "\u001b[31mExecution failed:\u001b[0m\n  caused by:\tBroken pipe\r\n",
    },
    { elapsed: 0, plan: "", rowCount: 0, tasks: 0, error: "later error" },
  );
  assert.equal(
    head.comparison(base),
    "q1: Previously succeeded, but now failed ❌: Execution failed: caused by: Broken pipe",
  );
  base.iterations[0]!.error = "different baseline error";
  assert.equal(
    head.comparison(base),
    "q1: Previously failed, and now also failed ❌: Execution failed: caused by: Broken pipe",
  );
  assert.equal(
    result("head", 100).comparison(base),
    "q1: Previously failed, but now succeeded 🟠",
  );
});

test("bounds error summaries without modifying stored diagnostics", () => {
  const base = result("base", 100);
  const head = result("head", 100);
  const prefix = "q1: Previously succeeded, but now failed ❌: ";
  for (const length of [299, 300, 301, 100_000]) {
    const error = "x".repeat(length);
    head.iterations[0]!.error = error;
    const summary = head.comparison(base).slice(prefix.length);
    assert.equal(summary.length, Math.min(length, 300));
    assert.equal(summary.endsWith("…"), length > 300);
    assert.equal(head.iterations[0]!.error, error);
  }
  head.iterations[0]!.error = " \n\t ";
  assert.equal(head.comparison(base), `${prefix}No error details available`);
});
