import assert from "node:assert/strict";
import test from "node:test";

import { JobDatabase, type NewJob } from "../src/database.js";
import type { GitHubApi } from "../src/github.js";
import { JobWorker } from "../src/worker.js";

const JOB: NewJob = {
  commentId: 7,
  repository: "datafusion-contrib/datafusion-distributed",
  pullRequestNumber: 99,
  pullRequestUrl:
    "https://github.com/datafusion-contrib/datafusion-distributed/pull/99",
  requestedBy: "maintainer",
  dataset: "tpch/sf1",
  benchmarkInstanceType: "c7i.2xlarge",
  benchmarkNodeCount: 12,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

test("reports a completed comparison and consumes the job", async () => {
  const database = new JobDatabase(":memory:");
  const comments: string[] = [];
  const commentIds: number[] = [];
  const github = {
    updateComment: async (_repo: string, commentId: number, body: string) => {
      commentIds.push(commentId);
      comments.push(body);
    },
  } as GitHubApi;
  try {
    const jobId = database.enqueue(JOB)!;
    database.setStatusCommentId(jobId, 77);
    const worker = new JobWorker(database, github, {
      execute: async () => ({ comparison: "TOTAL: 1.20 faster" }),
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.match(comments[0]!, /Running/);
    assert.match(comments[0]!, /12 `c7i\.2xlarge` nodes/);
    assert.match(comments[1]!, /TOTAL: 1.20 faster/);
    assert.match(comments[1]!, /12 `c7i\.2xlarge` nodes/);
    assert.deepEqual(commentIds, [77, 77]);
  } finally {
    database.close();
  }
});

test("does not publish command output when a job fails", async () => {
  const database = new JobDatabase(":memory:");
  const comments: string[] = [];
  const github = {
    updateComment: async (_repo: string, _commentId: number, body: string) => {
      comments.push(body);
    },
  } as GitHubApi;
  try {
    const jobId = database.enqueue(JOB)!;
    database.setStatusCommentId(jobId, 77);
    const worker = new JobWorker(database, github, {
      execute: async () => {
        throw new Error("arn:aws:iam::123456789012:role/private");
      },
    });
    await worker.runOnce();
    assert.match(comments[1]!, /controller journal/);
    assert.doesNotMatch(comments[1]!, /123456789012/);
  } finally {
    database.close();
  }
});

test("HTML-escapes benchmark comparison output", async () => {
  const database = new JobDatabase(":memory:");
  const comments: string[] = [];
  const github = {
    updateComment: async (_repo: string, _commentId: number, body: string) => {
      comments.push(body);
    },
  } as GitHubApi;
  try {
    const jobId = database.enqueue(JOB)!;
    database.setStatusCommentId(jobId, 77);
    const worker = new JobWorker(database, github, {
      execute: async () => ({ comparison: "</pre><script>alert(1)</script>" }),
    });
    await worker.runOnce();
    assert.match(comments[1]!, /&lt;script&gt;/);
    assert.doesNotMatch(comments[1]!, /<script>/);
  } finally {
    database.close();
  }
});
