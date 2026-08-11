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
  fs.mkdirSync(path.join(root, "tpch", "sf1"), { recursive: true });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function result(
  root: string,
  resultName: string,
  queryId: string,
): BenchResult {
  const value = new BenchResult("tpch/sf1", resultName, queryId, root);
  value.iterations.push({ elapsed: 10, plan: "", rowCount: 1, tasks: 1 });
  return value;
}

test("stores previous and per-result manifests with the exact query IDs", (t) => {
  const root = withDataset(t);
  const run = new BenchmarkRun("tpch/sf1", "base", 123, root);
  run.results.push(result(root, "base", "q1"), result(root, "base", "custom"));
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

  const previous = new BenchmarkRun(
    "tpch/sf1",
    "head",
    undefined,
    root,
  ).loadPrevious();
  assert.equal(previous?.resultName, "base");
  assert.deepEqual(
    previous?.results.map((value) => value.id),
    ["q1", "custom"],
  );
});

test("distinguishes missing result files from malformed result files", (t) => {
  const root = withDataset(t);
  assert.equal(BenchResult.load("tpch/sf1", "base", "q1", root), null);

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
    () => BenchResult.load("tpch/sf1", "base", "q1", root),
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
    () => new BenchmarkRun("tpch/sf1", "head", undefined, root).loadPrevious(),
    /Invalid previous run manifest/,
  );
});
