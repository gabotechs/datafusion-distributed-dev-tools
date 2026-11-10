import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workerManifests = [
  "datafusion/distributed-remote-worker/Cargo.toml",
  "benchmarks/remote-worker/Cargo.toml",
];

for (const manifests of [
  [workerManifests[0]!],
  [workerManifests[1]!],
  workerManifests,
  [],
]) {
  test(`isolated build selects a worker manifest from ${JSON.stringify(manifests)}`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-build-"));
    try {
      const source = path.join(directory, "source with spaces");
      const toolchain = path.join(directory, "rust-toolchain");
      const log = path.join(directory, "calls.jsonl");
      fs.mkdirSync(path.join(source, ".git"), { recursive: true });
      for (const manifest of ["Cargo.toml", "Cargo.lock", ...manifests]) {
        const file = path.join(source, manifest);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "");
      }
      fs.writeFileSync(toolchain, "1.90.0\n");
      // Intercept every privileged operation; exercise the real shell control flow.
      for (const program of ["install", "find", "systemd-run"])
        fs.writeFileSync(
          path.join(directory, program),
          `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({program: ${JSON.stringify(program)}, args: process.argv.slice(2)}) + '\\n');`,
          { mode: 0o755 },
        );
      const script = fs
        .readFileSync(
          new URL("../controller/datafusion-build", import.meta.url),
          "utf8",
        )
        .replace(
          "source_root=/opt/datafusion-pr-bot/datafusion-distributed",
          `source_root='${source}'`,
        )
        .replace(
          "toolchain_file=/etc/datafusion-pr-bot/rust-toolchain",
          `toolchain_file='${toolchain}'`,
        );
      const result = spawnSync("bash", ["-s"], {
        input: script,
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      });
      const calls = fs.existsSync(log)
        ? (fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)) as {
            program: string;
            args: string[];
          }[])
        : [];
      if (manifests.length === 0) {
        assert.equal(result.status, 2, result.stderr);
        assert.match(
          result.stderr,
          /Missing DataFusion remote worker manifest/,
        );
        for (const manifest of workerManifests)
          assert.ok(result.stderr.includes(path.join(source, manifest)));
        assert.deepEqual(calls, []);
      } else {
        assert.equal(result.status, 0, result.stderr);
        const commands = calls.filter((call) => call.program === "systemd-run");
        assert.deepEqual(
          commands.map(({ args }) =>
            args.slice(args.indexOf("--manifest-path")),
          ),
          [
            ["--manifest-path", path.join(source, "Cargo.toml")],
            [
              "--manifest-path",
              path.join(source, manifests[0]!),
              "--package",
              "datafusion-distributed-remote-worker",
              "--release",
              "--bin",
              "worker",
              "--target",
              "x86_64-unknown-linux-gnu",
            ],
          ],
        );
        assert.ok(commands[1]!.args.includes("--property=PrivateNetwork=yes"));
        assert.ok(commands[1]!.args.includes("--offline"));
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
