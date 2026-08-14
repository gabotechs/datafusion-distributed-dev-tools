import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareStoredResults } from "../src/lib/compare";
import { BenchmarkRun, BenchResult, RESULTS_DIR } from "../src/lib/results";

function result(
  root: string,
  dataset: string,
  resultName: string,
  query: string,
  elapsed: number,
  tasks = 1,
): BenchResult {
  const value = new BenchResult(dataset, resultName, query, root);
  value.iterations.push({ elapsed, plan: "", rowCount: 1, tasks });
  return value;
}

function storeRun(
  root: string,
  dataset: string,
  resultName: string,
  results: BenchResult[],
): void {
  const run = new BenchmarkRun(dataset, resultName, undefined, root);
  run.results.push(...results);
  run.store();
}

test("builds comparisons from stored completed runs", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "benchmark-file-compare-"),
  );
  fs.mkdirSync(path.join(root, "tpch", "sf1"), { recursive: true });

  try {
    storeRun(root, "tpch/sf1", "base", [
      result(root, "tpch/sf1", "base", "q1", 100),
    ]);
    storeRun(root, "tpch/sf1", "head", [
      result(root, "tpch/sf1", "head", "q1", 90),
    ]);

    const comparison = compareStoredResults("tpch/sf1", "base", "head", root);
    assert.match(comparison, /^=== Comparing tpch\/sf1 results/);
    assert.match(comparison, /q1: prev= 100 ms, new=  90 ms/);
    assert.match(comparison, /tasks: prev=1\.0, new=1\.0, diff=no change/);
    assert.match(comparison, /TASKS: prev=1\.0, new=1\.0, diff=no change/);
    assert.match(comparison, /TOTAL: prev=100 ms, new=90 ms/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compares per-query average tasks and sums them across queries", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "benchmark-file-compare-"),
  );
  fs.mkdirSync(path.join(root, "tpch", "sf1"), { recursive: true });

  try {
    const baseQ1 = result(root, "tpch/sf1", "base", "q1", 100, 6);
    baseQ1.iterations.push({ elapsed: 101, plan: "", rowCount: 1, tasks: 6 });
    const headQ1 = result(root, "tpch/sf1", "head", "q1", 90, 4);
    headQ1.iterations.push({ elapsed: 91, plan: "", rowCount: 1, tasks: 6 });
    storeRun(root, "tpch/sf1", "base", [
      baseQ1,
      result(root, "tpch/sf1", "base", "q2", 200, 10),
    ]);
    storeRun(root, "tpch/sf1", "head", [
      headQ1,
      result(root, "tpch/sf1", "head", "q2", 180, 10),
    ]);

    const comparison = compareStoredResults("tpch/sf1", "base", "head", root);
    assert.match(
      comparison,
      /q1:.*tasks: prev=6\.0, new=5\.0, diff=1\.0 fewer \(16\.7%\)/,
    );
    assert.match(
      comparison,
      /TASKS: prev=16\.0, new=15\.0, diff=1\.0 fewer \(6\.3%\) \(sum of per-query averages\)/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps legacy per-query result directories comparable", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "benchmark-file-compare-"),
  );
  fs.mkdirSync(path.join(root, "tpch", "sf1"), { recursive: true });

  try {
    result(root, "tpch/sf1", "base", "q1", 100).store();
    result(root, "tpch/sf1", "head", "q1", 90).store();
    assert.match(
      compareStoredResults("tpch/sf1", "base", "head", root),
      /TOTAL: prev=100 ms, new=90 ms/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects incomplete stored comparisons", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "benchmark-file-compare-"),
  );
  fs.mkdirSync(path.join(root, "tpch", "sf1"), { recursive: true });

  try {
    storeRun(root, "tpch/sf1", "base", [
      result(root, "tpch/sf1", "base", "q1", 100),
    ]);
    storeRun(root, "tpch/sf1", "head", [
      result(root, "tpch/sf1", "head", "q2", 90),
    ]);
    assert.throws(
      () => compareStoredResults("tpch/sf1", "base", "head", root),
      /Stored query sets differ/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores stale query files left by a smaller completed run", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "benchmark-file-compare-"),
  );
  fs.mkdirSync(path.join(root, "tpch", "sf1"), { recursive: true });

  try {
    for (const resultName of ["base", "head"]) {
      storeRun(root, "tpch/sf1", resultName, [
        result(
          root,
          "tpch/sf1",
          resultName,
          "q1",
          resultName === "base" ? 100 : 90,
        ),
        result(
          root,
          "tpch/sf1",
          resultName,
          "q2",
          resultName === "base" ? 200 : 180,
        ),
      ]);
      storeRun(root, "tpch/sf1", resultName, [
        result(
          root,
          "tpch/sf1",
          resultName,
          "q1",
          resultName === "base" ? 80 : 70,
        ),
      ]);
      assert.equal(
        fs.existsSync(
          path.join(root, "tpch", "sf1", RESULTS_DIR, resultName, "q2.json"),
        ),
        true,
      );
    }

    const comparison = compareStoredResults("tpch/sf1", "base", "head", root);
    assert.match(comparison, /q1: prev=  80 ms, new=  70 ms/);
    assert.doesNotMatch(comparison, /q2:/);
    assert.match(comparison, /TOTAL: prev=80 ms, new=70 ms/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
