import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  BenchmarkRun,
  BenchResult,
  PREVIOUS_RUN_FILE,
  RESULTS_DIR,
  RUN_MANIFEST_DIR,
  RUN_MANIFEST_FILE,
  runManifestSchema,
} from "../src/lib/results";

function withDataset(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-results-"));
  const previousRoot = process.env.BENCHMARK_TESTDATA_ROOT;
  process.env.BENCHMARK_TESTDATA_ROOT = root;
  fs.mkdirSync(path.join(root, "tpch", "sf1"), { recursive: true });
  t.after(() => {
    if (previousRoot === undefined) delete process.env.BENCHMARK_TESTDATA_ROOT;
    else process.env.BENCHMARK_TESTDATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function result(engine: string, queryId: string): BenchResult {
  const value = new BenchResult("tpch/sf1", engine, queryId);
  value.iterations.push({ elapsed: 10, plan: "", rowCount: 1, tasks: 1 });
  return value;
}

test("stores previous and per-engine manifests with the exact query IDs", (t) => {
  const root = withDataset(t);
  const run = new BenchmarkRun("tpch/sf1", "base", 123);
  run.results.push(result("base", "q1"), result("base", "custom"));
  run.store();

  const manifestPath = path.join(
    root,
    "tpch",
    "sf1",
    RESULTS_DIR,
    PREVIOUS_RUN_FILE,
  );
  const expectedManifest = {
    version: 1,
    startTime: 123,
    dataset: "tpch/sf1",
    engine: "base",
    queryIds: ["q1", "custom"],
  } as const;
  const manifest = runManifestSchema.parse(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  );
  assert.deepEqual(manifest, expectedManifest);
  const engineManifestPath = path.join(
    root,
    "tpch",
    "sf1",
    RESULTS_DIR,
    "base",
    RUN_MANIFEST_DIR,
    RUN_MANIFEST_FILE,
  );
  assert.deepEqual(
    runManifestSchema.parse(
      JSON.parse(fs.readFileSync(engineManifestPath, "utf8")),
    ),
    expectedManifest,
  );

  const previous = new BenchmarkRun("tpch/sf1", "head").loadPrevious();
  assert.equal(previous?.engine, "base");
  assert.deepEqual(
    previous?.results.map((value) => value.id),
    ["q1", "custom"],
  );
});

test("distinguishes missing result files from malformed result files", (t) => {
  const root = withDataset(t);
  assert.equal(BenchResult.load("tpch/sf1", "base", "q1"), null);

  const resultPath = path.join(
    root,
    "tpch",
    "sf1",
    RESULTS_DIR,
    "base",
    "q1.json",
  );
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, "not JSON");
  assert.throws(
    () => BenchResult.load("tpch/sf1", "base", "q1"),
    /Invalid benchmark result.*Invalid JSON/,
  );
});

test("reports malformed previous-run manifests instead of treating them as absent", (t) => {
  const root = withDataset(t);
  const manifestPath = path.join(
    root,
    "tpch",
    "sf1",
    RESULTS_DIR,
    PREVIOUS_RUN_FILE,
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ engine: "base" }));
  assert.throws(
    () => new BenchmarkRun("tpch/sf1", "head").loadPrevious(),
    /Invalid previous run manifest/,
  );
});
