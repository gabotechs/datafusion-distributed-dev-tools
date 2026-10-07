import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("benchmark results remain local", () => {
  const runner = fs.readFileSync(
    path.resolve(__dirname, "../src/lib/engine-cli.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    runner,
    /resultsBucketName|RESULTS_BUCKET|_SUCCESS|head-object/,
  );
  assert.match(runner, /console\.error\("Benchmark run completed"\)/);
});

test("benchmark runs do not create cluster state", () => {
  const runner = fs.readFileSync(
    path.resolve(__dirname, "../src/lib/engine-cli.ts"),
    "utf8",
  );
  const library = fs.readFileSync(
    path.resolve(__dirname, "../src/lib/operations.ts"),
    "utf8",
  );
  assert.doesNotMatch(runner, /benchmark_lock|heartbeat|configmap/);
  assert.doesNotMatch(library, /benchmark_lock|heartbeat|configmap/);
});

test("engine publishers return artifacts directly without runtime files", () => {
  for (const file of [
    "lib/operations.ts",
    "lib/deployment.ts",
    "bin/datafusion-deploy.ts",
    "bin/ballista-deploy.ts",
    "bin/spark-deploy.ts",
    "lib/publishing.ts",
  ]) {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src", file),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /runtime_file|K8S_RUNTIME_FILE|update_runtime_file|output_value/,
    );
  }
});

test("all benchmark clients use the same local port", () => {
  for (const client of [
    "datafusion-bench.ts",
    "trino-bench.ts",
    "spark-bench.ts",
    "ballista-bench.ts",
    "clickhouse-bench.ts",
  ]) {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/bin", client),
      "utf8",
    );
    assert.match(source, /options\.url/, client);
  }

  const cli = fs.readFileSync(
    path.resolve(__dirname, "../src/lib/engine-cli.ts"),
    "utf8",
  );
  assert.match(cli, /"http:\/\/localhost:9000"/);
  const runner = fs.readFileSync(
    path.resolve(__dirname, "../src/lib/port-forward.ts"),
    "utf8",
  );
  assert.match(runner, /"9000:9000"/);
  assert.doesNotMatch(runner, /case \$\{engine\}|_URL=/);
});

test("benchmark npm commands execute their TypeScript clients directly", () => {
  const packageJson = fs.readFileSync(
    path.resolve(__dirname, "../package.json"),
    "utf8",
  );
  assert.doesNotMatch(packageJson, /run-benchmark\.sh|runner:/);
  for (const engine of [
    "datafusion",
    "trino",
    "spark",
    "ballista",
    "clickhouse",
  ]) {
    assert.match(packageJson, new RegExp(`tsx src/bin/${engine}-bench\\.ts`));
  }
});
