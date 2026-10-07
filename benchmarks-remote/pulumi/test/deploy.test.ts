import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { foundationPaths, mergeCidrs } from "../../src/lib/foundation";

test("deploy keeps CIDRs the cluster already allows", () => {
  assert.deepEqual(
    mergeCidrs(
      ["192.0.2.10/32"],
      ["203.0.113.5/32", "192.0.2.10/32", "0.0.0.0/0"],
      "198.51.100.7",
    ),
    ["192.0.2.10/32", "198.51.100.7/32", "203.0.113.5/32"],
  );
});
test("first deploy accepts wrapped and encoded Pulumi configuration", () => {
  for (const configured of [
    ["192.0.2.10/32"],
    { value: ["192.0.2.10/32"] },
    { value: '["192.0.2.10/32"]' },
    '["192.0.2.10/32"]',
  ])
    assert.deepEqual(mergeCidrs(configured, [], "198.51.100.7"), [
      "192.0.2.10/32",
      "198.51.100.7/32",
    ]);
});
test("alternate foundations use separate output and kubeconfig files", () => {
  const paths = foundationPaths({ stack: "pr-bot" });
  assert.ok(paths.outputs.endsWith(".pulumi-outputs.pr-bot.json"));
  assert.ok(paths.kubeconfig.endsWith(".kubeconfig.pr-bot"));
  assert.throws(() => foundationPaths({ stack: "../bad" }));
});
test("foundation CLI persists an explicit allowlist and writes outputs before installing tenancy", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "foundation-cli-"));
  try {
    const log = path.join(directory, "calls.jsonl");
    const outputs = path.join(directory, "outputs.json");
    const kubeconfig = path.join(directory, "kubeconfig");
    for (const program of ["pulumi", "aws", "helm"])
      fs.writeFileSync(
        path.join(directory, program),
        `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({program:${JSON.stringify(program)},args})+'\\n');if(${JSON.stringify(program)}==='pulumi'&&args[0]==='stack'&&args[1]==='output')console.log(JSON.stringify({clusterName:'cluster',datasetBucketName:'datasets'}));`,
        { mode: 0o755 },
      );
    const root = path.resolve(__dirname, "../..");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(root, "src/bin/deploy-foundation.ts"),
        "--stack",
        "test-stack",
        "--region",
        "us-west-2",
        "--allowed-cidrs",
        "192.0.2.20/32",
        "--outputs-file",
        outputs,
        "--kubeconfig",
        kubeconfig,
        "--pulumi-bin",
        path.join(directory, "pulumi"),
      ],
      {
        cwd: root,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      (JSON.parse(fs.readFileSync(outputs, "utf8")) as { clusterName: string })
        .clusterName,
      "cluster",
    );
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { program: string; args: string[] });
    const config = calls.find(
      (call) => call.program === "pulumi" && call.args[0] === "config",
    )!;
    assert.deepEqual(config.args, [
      "config",
      "set",
      "kubernetesApiAllowedCidrs",
      '["192.0.2.20/32"]',
      "--stack",
      "test-stack",
    ]);
    assert.ok(
      calls
        .find(
          (call) =>
            call.program === "aws" && call.args.includes("update-kubeconfig"),
        )!
        .args.includes(kubeconfig),
    );
    assert.ok(
      calls
        .find((call) => call.program === "helm")!
        .args.includes("benchmark-tenancy"),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
