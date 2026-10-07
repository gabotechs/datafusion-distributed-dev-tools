import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const botRoot = fileURLToPath(new URL("../", import.meta.url));
interface Call {
  program: string;
  args: string[];
  cwd: string;
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cli-"));
  const log = path.join(directory, "calls.jsonl");
  for (const program of ["npm", "pulumi", "aws", "custom pulumi"]) {
    fs.writeFileSync(
      path.join(directory, program),
      `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({program:${JSON.stringify(program)},args,cwd:process.cwd()})+'\\n'); if(process.env.FAIL_PROGRAM===${JSON.stringify(program)}) process.exit(7); if(${JSON.stringify(program)}.includes('pulumi') && args.includes('output')) console.log(args.includes('--json') ? '{"controllerInstanceId":"i-0123456789abcdef0"}' : (process.env.INSTANCE_ID ?? 'i-0123456789abcdef0'));`,
      { mode: 0o755 },
    );
  }
  return {
    directory,
    run: (
      operation: string,
      args: string[] = [],
      env: NodeJS.ProcessEnv = {},
    ) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(botRoot, "src/bin", `bot-${operation}.ts`),
          ...args,
        ],
        {
          cwd: botRoot,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            ...env,
          },
          encoding: "utf8",
        },
      ),
    calls: (): Call[] =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Call)
        : [],
    close: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test("bot help and invalid options invoke no tools", () => {
  const f = fixture();
  try {
    for (const operation of ["deploy", "destroy", "outputs", "session"]) {
      const result = f.run(operation, ["--help"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /--stack NAME/);
      assert.match(result.stdout, /controller/);
      assert.notEqual(f.run(operation, ["--unknown"]).status, 0);
    }
    assert.deepEqual(f.calls(), []);
  } finally {
    f.close();
  }
});

test("deploy builds both bundles before updating the default or selected stack", () => {
  for (const stack of [undefined, "other-stack"]) {
    const f = fixture();
    try {
      const result = f.run("deploy", stack ? ["--stack", stack, "--yes"] : []);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        f.calls().map(({ program, args }) => ({ program, args })),
        [
          { program: "npm", args: ["run", "application:build"] },
          { program: "npm", args: ["run", "pulumi:build"] },
          {
            program: "pulumi",
            args: [
              "up",
              "--stack",
              stack ?? "controller",
              ...(stack ? ["--yes"] : []),
            ],
          },
        ],
      );
      assert.ok(
        f
          .calls()
          .every((call) => path.resolve(call.cwd) === path.resolve(botRoot)),
      );
    } finally {
      f.close();
    }
  }
});

test("destroy and outputs use the same default and overridden stacks", () => {
  for (const operation of ["destroy", "outputs"]) {
    for (const stack of [undefined, "other-stack"]) {
      const f = fixture();
      try {
        const result = f.run(operation, stack ? ["--stack", stack] : []);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          f.calls()[0]!.args,
          operation === "destroy"
            ? ["destroy", "--stack", stack ?? "controller"]
            : ["stack", "output", "--stack", stack ?? "controller", "--json"],
        );
        assert.equal(f.calls().length, 1);
        if (operation === "outputs")
          assert.equal(
            result.stdout,
            '{"controllerInstanceId":"i-0123456789abcdef0"}\n',
          );
      } finally {
        f.close();
      }
    }
  }
});

test("session resolves the selected stack's instance and forwards the AWS region", () => {
  for (const stack of [undefined, "other-stack"]) {
    const f = fixture();
    try {
      const result = f.run(
        "session",
        stack ? ["--stack", stack, "--region", "eu-west-1"] : [],
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        f.calls().map(({ program, args }) => ({ program, args })),
        [
          {
            program: "pulumi",
            args: [
              "stack",
              "output",
              "controllerInstanceId",
              "--stack",
              stack ?? "controller",
            ],
          },
          {
            program: "aws",
            args: [
              ...(stack ? ["--region", "eu-west-1"] : []),
              "ssm",
              "start-session",
              "--target",
              "i-0123456789abcdef0",
            ],
          },
        ],
      );
      assert.equal(result.stdout, "");
    } finally {
      f.close();
    }
  }
});

test("custom Pulumi paths and stack names remain literal arguments", () => {
  const f = fixture();
  try {
    const stack = "org/project/other-stack";
    const result = f.run("destroy", [
      "--stack",
      stack,
      "--pulumi-bin",
      path.join(f.directory, "custom pulumi"),
      "--yes",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.calls()[0]!.program, "custom pulumi");
    assert.deepEqual(f.calls()[0]!.args, [
      "destroy",
      "--stack",
      stack,
      "--yes",
    ]);
  } finally {
    f.close();
  }
});

test("tool failures and invalid instance outputs stop before subsequent operations", () => {
  for (const [operation, env, expectedCalls] of [
    ["deploy", { FAIL_PROGRAM: "npm" }, 1],
    ["session", { FAIL_PROGRAM: "pulumi" }, 1],
    ["session", { INSTANCE_ID: "" }, 1],
    ["session", { INSTANCE_ID: "not-an-instance" }, 1],
    ["session", { FAIL_PROGRAM: "aws" }, 2],
  ] as const) {
    const f = fixture();
    try {
      assert.notEqual(f.run(operation, [], env).status, 0);
      assert.equal(f.calls().length, expectedCalls);
    } finally {
      f.close();
    }
  }
});
