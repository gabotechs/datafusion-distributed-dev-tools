import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  deploymentName,
  workerSelector,
  type Engine,
} from "../src/lib/operations";

const root = path.resolve(__dirname, "..");
interface Call {
  program: string;
  args: string[];
  kubeconfig?: string;
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const outputs = path.join(directory, "outputs.json");
  const log = path.join(directory, "calls.jsonl");
  fs.writeFileSync(
    outputs,
    JSON.stringify({
      clusterName: "test-cluster",
      datasetBucketName: "test-datasets",
      benchmarkNodeCount: 12,
      benchmarkInstanceType: "c5n.2xlarge",
      coordinatorInstanceType: "m6i.large",
    }),
  );
  for (const name of ["aws", "helm", "kubectl", "cargo", "sudo"]) {
    fs.writeFileSync(
      path.join(directory, name),
      `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({program:${JSON.stringify(name)},args,kubeconfig:process.env.KUBECONFIG})+'\\n'); if(${JSON.stringify(name)}==='aws'&&args.includes('head-object')) process.exit(1); if(${JSON.stringify(name)}==='kubectl'&&args.includes('pods')) console.log('worker-1');`,
      { mode: 0o755 },
    );
  }
  return {
    directory,
    calls: (): Call[] =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Call)
        : [],
    run: (script: string, args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(root, "src/bin", `${script}.ts`),
          ...args,
          "--outputs-file",
          outputs,
          "--kubeconfig",
          path.join(directory, "kubeconfig"),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            DEPLOYMENT_NAME: "ignored-env-name",
            NODE_COUNT: "999",
          },
          encoding: "utf8",
        },
      ),
    close: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
test("deploy and destroy use explicit names and the same Kubernetes configuration", () => {
  const f = fixture();
  try {
    let result = f.run("datafusion-deploy", [
      "--deployment-name",
      "my-worker",
      "--nodes",
      "3",
      "--worker-cpu",
      "6",
      "--worker-memory",
      "16Gi",
      "--worker-artifact",
      "s3://artifacts/worker",
    ]);
    assert.equal(result.status, 0, result.stderr);
    result = f.run("datafusion-destroy", ["--deployment-name", "my-worker"]);
    assert.equal(result.status, 0, result.stderr);
    const helm = f.calls().filter((call) => call.program === "helm");
    assert.deepEqual(helm[0]!.args.slice(0, 3), [
      "upgrade",
      "--install",
      "my-worker",
    ]);
    for (const setting of [
      "name=my-worker",
      "worker.replicas=3",
      "workerResources.requests.cpu=6",
      "workerResources.limits.memory=16Gi",
      "worker.artifact=s3://artifacts/worker",
    ])
      assert.ok(helm[0]!.args.includes(setting), setting);
    assert.deepEqual(helm[1]!.args.slice(0, 2), ["uninstall", "my-worker"]);
    assert.equal(helm[0]!.kubeconfig, helm[1]!.kubeconfig);
    assert.ok(!f.calls().some((call) => call.program === "cargo"));
  } finally {
    f.close();
  }
});
test("invalid deployment options fail before invoking external tools", () => {
  for (const args of [
    ["--nodes", "0"],
    ["--nodes", "1.5"],
    ["--deployment-name", "../oops"],
    ["--worker-cpu", "7"],
    ["--unknown", "x"],
  ]) {
    const f = fixture();
    try {
      const result = f.run("datafusion-deploy", args);
      assert.notEqual(result.status, 0);
      assert.deepEqual(f.calls(), []);
    } finally {
      f.close();
    }
  }
});
test("publishing honors source and target paths and keeps stdout machine-readable", () => {
  const f = fixture();
  try {
    const source = path.join(f.directory, "source with spaces");
    const target = path.join(f.directory, "target with spaces");
    fs.mkdirSync(path.join(target, "x86_64-unknown-linux-gnu/release"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(target, "x86_64-unknown-linux-gnu/release/worker"),
      "binary",
    );
    const result = f.run("publish-datafusion", [
      "--source-root",
      source,
      "--target-dir",
      target,
      "--artifact-bucket",
      "test-artifacts",
      "--artifact-prefix",
      "workers/datafusion",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /^s3:\/\/test-artifacts\/workers\/datafusion\/[a-f0-9]{64}\/worker\n$/,
    );
    const cargo = f.calls().find((call) => call.program === "cargo")!;
    assert.ok(
      cargo.args.includes(
        path.join(source, "benchmarks/remote-worker/Cargo.toml"),
      ),
    );
    assert.deepEqual(cargo.args.slice(-4), [
      "--bin",
      "worker",
      "--target",
      "x86_64-unknown-linux-gnu",
    ]);
    const upload = f
      .calls()
      .find((call) => call.program === "aws" && call.args.includes("cp"))!;
    assert.ok(
      upload.args.includes(
        path.join(target, "x86_64-unknown-linux-gnu/release/worker"),
      ),
    );
  } finally {
    f.close();
  }
});
test("worker commands forward flags literally after --", () => {
  const f = fixture();
  try {
    // Configuration flags must precede the delimiter; the remaining flags belong to the remote command.
    const script = path.join(root, "src/bin/command.ts");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        script,
        "--outputs-file",
        path.join(f.directory, "outputs.json"),
        "--kubeconfig",
        path.join(f.directory, "kubeconfig"),
        "spark",
        "--",
        "printf",
        "%s",
        "a b",
        "--help",
      ],
      {
        cwd: root,
        env: { ...process.env, PATH: `${f.directory}:${process.env.PATH}` },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const exec = f.calls().find((call) => call.args.includes("exec"))!;
    assert.deepEqual(exec.args.slice(-5), [
      "--",
      "printf",
      "%s",
      "a b",
      "--help",
    ]);
  } finally {
    f.close();
  }
});
test("all engine charts deploy through the TypeScript CLI", () => {
  for (const engine of ["trino", "spark", "ballista", "clickhouse"]) {
    const f = fixture();
    try {
      const target = path.join(f.directory, "target");
      if (engine === "ballista") {
        const binaries = path.join(target, "x86_64-unknown-linux-gnu/release");
        fs.mkdirSync(binaries, { recursive: true });
        for (const binary of [
          "ballista-scheduler",
          "ballista-executor",
          "ballista-http",
        ])
          fs.writeFileSync(path.join(binaries, binary), binary);
      }
      const result = f.run(`${engine}-deploy`, [
        "--deployment-name",
        "test-release",
        ...(engine === "ballista" ? ["--target-dir", target] : []),
        ...(engine === "spark" ? ["--spark-image", "test/image:tag"] : []),
      ]);
      assert.equal(result.status, 0, result.stderr);
      const helm = f.calls().find((call) => call.program === "helm")!;
      assert.ok(helm.args.includes(`benchmark-${engine}`));
      assert.ok(helm.args.includes("workerReplicas=12"));
      assert.ok(helm.args.includes("workerInstanceType=c5n.2xlarge"));
      assert.equal(
        helm.args.includes("coordinatorInstanceType=m6i.large"),
        engine !== "clickhouse",
      );
      if (engine === "trino") {
        assert.ok(helm.args.includes("region=us-east-1"));
        assert.ok(helm.args.includes("datasetBucket=test-datasets"));
      }
      if (engine === "spark")
        assert.ok(helm.args.includes("image=test/image:tag"));
      if (engine === "ballista") {
        assert.ok(helm.args.includes("datasetBucket=test-datasets"));
        for (const component of ["scheduler", "executor", "http"])
          assert.ok(
            helm.args.some(
              (arg) =>
                arg.startsWith(
                  `artifacts.${component}=s3://test-datasets/.benchmark-artifacts/ballista/`,
                ) && arg.endsWith(`/ballista-${component}`),
            ),
          );
      }

      assert.ok(
        helm.args.includes(path.join(root, "k8s/worker-resources.yaml")),
      );
    } finally {
      f.close();
    }
  }
});
test("shared engine names, release validation and worker selectors", () => {
  for (const engine of [
    "datafusion",
    "trino",
    "spark",
    "ballista",
    "clickhouse",
  ] as Engine[]) {
    assert.ok(deploymentName(engine).startsWith(`${engine}-`));
    assert.ok(
      workerSelector(engine).includes(
        engine === "datafusion" ? "datafusion-worker" : engine,
      ),
    );
  }
  assert.throws(() => deploymentName("datafusion", "x".repeat(54)));
  assert.equal(deploymentName("datafusion", "valid-release"), "valid-release");
});

test("migrated commands use Optique help without invoking external tools", () => {
  const f = fixture();
  try {
    for (const script of [
      "command",
      "datafusion-deploy",
      "trino-deploy",
      "spark-deploy",
      "ballista-deploy",
      "clickhouse-deploy",
      "datafusion-destroy",
      "trino-destroy",
      "spark-destroy",
      "ballista-destroy",
      "clickhouse-destroy",
      "deploy-foundation",
      "destroy-foundation",
      "install-tenancy",
      "publish-datafusion",
      "publish-ballista",
      "publish-image",
      "sum-tasks",
      "test-render",
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(root, "src/bin", `${script}.ts`),
          "--help",
        ],
        {
          cwd: root,
          env: { ...process.env, PATH: `${f.directory}:${process.env.PATH}` },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
      assert.match(result.stdout, /^Usage:/, script);
      assert.match(result.stdout, /--help\s+Show help information/, script);
      assert.equal(result.stderr, "", script);
    }
    assert.deepEqual(f.calls(), []);
  } finally {
    f.close();
  }
});

test("engine deployment help and accepted options are engine-specific", () => {
  const f = fixture();
  try {
    for (const engine of [
      "datafusion",
      "trino",
      "spark",
      "ballista",
      "clickhouse",
    ]) {
      const result = f.run(`${engine}-deploy`, ["--help"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`${engine}-deploy.ts `));
      assert.doesNotMatch(result.stdout, /\bTYPE\b/);
      assert.equal(result.stdout.includes("--spark-image"), engine === "spark");
      assert.equal(
        result.stdout.includes("--worker-artifact"),
        engine === "datafusion",
      );
      assert.equal(
        result.stdout.includes("--source-root"),
        engine === "datafusion",
      );
      assert.equal(
        result.stdout.includes("--target-dir"),
        engine === "datafusion" || engine === "ballista",
      );
      assert.equal(
        result.stdout.includes("--build-wrapper"),
        engine === "datafusion",
      );
      const invalid = f.run(`${engine}-deploy`, [
        engine === "spark" ? "--worker-artifact" : "--spark-image",
        "unused",
      ]);
      assert.notEqual(invalid.status, 0, engine);
    }
    assert.deepEqual(f.calls(), []);
  } finally {
    f.close();
  }
});

test("each engine destroy CLI has specific help and uninstalls only its named release", () => {
  for (const engine of [
    "datafusion",
    "trino",
    "spark",
    "ballista",
    "clickhouse",
  ]) {
    const f = fixture();
    try {
      const help = f.run(`${engine}-destroy`, ["--help"]);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, new RegExp(`${engine}-destroy.ts `));
      assert.doesNotMatch(
        help.stdout,
        /\bTYPE\b|--nodes|--instance-type|--source-root|--spark-image|--worker-artifact/,
      );
      for (const args of [
        ["--deployment-name", "../oops"],
        ["--nodes", "3"],
        [engine],
      ]) {
        const invalid = f.run(`${engine}-destroy`, args);
        assert.notEqual(invalid.status, 0, `${engine}: ${args.join(" ")}`);
      }
      assert.deepEqual(f.calls(), []);
      const result = f.run(`${engine}-destroy`, [
        "--deployment-name",
        "my-release",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const helm = f.calls().find((call) => call.program === "helm")!;
      assert.deepEqual(helm.args, [
        "uninstall",
        "my-release",
        "--namespace",
        `benchmark-${engine}`,
        "--ignore-not-found",
        "--wait",
        "--timeout",
        "10m",
        "--kube-context",
        "test-cluster",
      ]);
    } finally {
      f.close();
    }
  }
});
