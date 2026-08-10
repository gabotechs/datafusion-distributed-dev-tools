import assert from "node:assert/strict";
import test from "node:test";

import { JobDatabase, type NewJob } from "../src/database.js";

const JOB: NewJob = {
  commentId: 42,
  repository: "datafusion-contrib/datafusion-distributed",
  pullRequestNumber: 123,
  pullRequestUrl:
    "https://github.com/datafusion-contrib/datafusion-distributed/pull/123",
  requestedBy: "maintainer",
  dataset: "tpch/sf1",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

test("deduplicates comments while preserving immutable refs", () => {
  const database = new JobDatabase(":memory:");
  try {
    assert.equal(database.enqueue(JOB), 1);
    assert.equal(database.enqueue(JOB), null);
    assert.equal(database.isCommentSeen(JOB.commentId), true);
    const queued = database.nextPending();
    assert.equal(queued?.dataset, "tpch/sf1");
    assert.equal(queued?.baseSha, JOB.baseSha);
    assert.equal(queued?.headSha, JOB.headSha);
  } finally {
    database.close();
  }
});

test("claims a pending job atomically", () => {
  const database = new JobDatabase(":memory:");
  try {
    database.enqueue(JOB);
    assert.equal(database.claimNextPending()?.status, "running");
    assert.equal(database.claimNextPending(), null);
  } finally {
    database.close();
  }
});

test("recovers a job interrupted while running", () => {
  const database = new JobDatabase(":memory:");
  try {
    database.enqueue(JOB);
    assert.equal(database.claimNextPending()?.status, "running");
    assert.equal(database.recoverRunningJobs(), 1);
    assert.equal(database.claimNextPending()?.status, "running");
  } finally {
    database.close();
  }
});
