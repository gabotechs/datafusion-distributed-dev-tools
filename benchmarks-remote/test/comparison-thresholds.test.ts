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

  assert.match(normalRegression, /1\.49 slower ✖$/);
  assert.match(highlightedRegression, /1\.50 slower ❌$/);
  assert.match(highlightedImprovement, /1\.50 faster ✅$/);
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
