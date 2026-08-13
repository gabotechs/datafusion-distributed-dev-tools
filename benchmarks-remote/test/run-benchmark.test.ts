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
    path.resolve(__dirname, "../k8s/lib.sh"),
    "utf8",
  );
  assert.doesNotMatch(runner, /benchmark_lock|heartbeat|configmap/);
  assert.doesNotMatch(library, /benchmark_lock|heartbeat|configmap/);
});

test("all benchmark clients use the same local port", () => {
  for (const client of [
    "datafusion-bench.ts",
    "trino-bench.ts",
    "spark-bench.ts",
    "ballista-bench.ts",
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
  for (const engine of ["datafusion", "trino", "spark", "ballista"]) {
    assert.match(packageJson, new RegExp(`tsx src/bin/${engine}-bench\\.ts`));
  }
});

test("publishes the DataFusion worker from its crate target directory", () => {
  const publisher = fs.readFileSync(
    path.resolve(__dirname, "../k8s/publish-datafusion.sh"),
    "utf8",
  );
  assert.match(
    publisher,
    /target_dir=\$\{CARGO_TARGET_DIR:-\$\{root\}\/benchmarks-remote\/engines\/datafusion\/target\}/,
  );
  assert.match(
    publisher,
    /worker_binary="\$\{target_dir\}\/x86_64-unknown-linux-gnu\/release\/worker"/,
  );
});
