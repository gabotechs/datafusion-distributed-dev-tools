import assert from "node:assert/strict";
import test from "node:test";

import { GhCliClient } from "../src/github.js";
import type { ProcessRunner, RunOptions, RunResult } from "../src/process.js";

class RecordingProcesses implements ProcessRunner {
  calls: Array<{
    program: string;
    arguments_: readonly string[];
    options: RunOptions | undefined;
  }> = [];
  outputs: string[] = [];

  async run(
    program: string,
    arguments_: readonly string[],
    options?: RunOptions,
  ): Promise<RunResult> {
    this.calls.push({ program, arguments_, options });
    return {
      exitCode: 0,
      stdout: this.outputs.shift() ?? "{}",
      stderr: "",
    };
  }
}

test("lists all comment pages through the authenticated gh CLI", async () => {
  const processes = new RecordingProcesses();
  processes.outputs.push(
    JSON.stringify([[{ id: 1, body: "first" }], [{ id: 2, body: "second" }]]),
  );
  const comments = await new GhCliClient(processes).listIssueComments(
    "owner/repository",
    "2026-08-10T00:00:00.000Z",
  );
  assert.deepEqual(
    comments.map((comment) => comment.id),
    [1, 2],
  );
  assert.equal(processes.calls[0]?.program, "gh");
  assert.deepEqual(processes.calls[0]?.arguments_.slice(0, 3), [
    "api",
    "--paginate",
    "--slurp",
  ]);
});

test("posts comments without invoking a shell", async () => {
  const processes = new RecordingProcesses();
  const body = "result $(do-not-expand)";
  await new GhCliClient(processes).postComment("owner/repository", 42, body);
  assert.deepEqual(processes.calls[0]?.arguments_, [
    "api",
    "--method",
    "POST",
    "/repos/owner/repository/issues/42/comments",
    "--field",
    `body=${body}`,
  ]);
});
