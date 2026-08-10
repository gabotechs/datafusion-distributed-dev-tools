import assert from "node:assert/strict";
import test from "node:test";

import { JobDatabase } from "../src/database.js";
import type { GitHubApi, IssueComment } from "../src/github.js";
import { CommentPoller } from "../src/poller.js";

function comment(id: number, login: string): IssueComment {
  return {
    id,
    body: "benchmarks run tpch/sf1 --instance-type c7i.2xlarge --nodes 12",
    issue_url: `https://api.github.com/repos/owner/repository/issues/${id}`,
    html_url: `https://github.com/owner/repository/issues/${id}`,
    created_at: `2026-08-10T00:00:0${id}.000Z`,
    updated_at: `2026-08-10T00:00:0${id}.000Z`,
    user: { login },
  };
}

test("a failing comment does not prevent later comments from being queued", async () => {
  const database = new JobDatabase(":memory:");
  const comments = [comment(1, "deleted-user"), comment(2, "maintainer")];
  const github = {
    listIssueComments: async () => comments,
    hasWritePermission: async (_repository: string, login: string) => {
      if (login === "deleted-user") throw new Error("temporary API failure");
      return true;
    },
    getPullRequest: async (_repository: string, number: number) => ({
      number,
      html_url: `https://github.com/owner/repository/pull/${number}`,
      base: { sha: "a".repeat(40), ref: "main" },
      head: { sha: "b".repeat(40), ref: "feature" },
    }),
    postComment: async () => {},
  } as unknown as GitHubApi;
  try {
    await new CommentPoller("owner/repository", database, github).poll(
      new Date("2026-08-10T00:10:00.000Z"),
    );
    assert.equal(database.nextPending()?.commentId, 2);
    assert.equal(database.isCommentSeen(1), false);
    assert.equal(
      database.canAttemptComment(1, new Date("2026-08-10T00:10:00.000Z")),
      false,
    );
  } finally {
    database.close();
  }
});

test("drops a permanently failing comment after three attempts", async () => {
  const database = new JobDatabase(":memory:");
  const failing = comment(1, "deleted-user");
  const github = {
    hasWritePermission: async () => {
      throw new Error("permanent API failure");
    },
  } as unknown as GitHubApi;
  const poller = new CommentPoller("owner/repository", database, github);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const minute = String(attempt * 10).padStart(2, "0");
      const terminal = await poller.processSafely(
        failing,
        new Date(`2026-08-10T00:${minute}:00.000Z`),
      );
      assert.equal(terminal, attempt === 2);
    }
    assert.equal(database.isCommentSeen(1), true);
  } finally {
    database.close();
  }
});
