import assert from "node:assert/strict";
import test from "node:test";

import { JobDatabase, QueueLimitError, type NewJob } from "../src/database.js";

const JOB: NewJob = {
  commentId: 42,
  repository: "datafusion-contrib/datafusion-distributed",
  pullRequestNumber: 123,
  pullRequestUrl:
    "https://github.com/datafusion-contrib/datafusion-distributed/pull/123",
  requestedBy: "maintainer",
  dataset: "tpch/sf1",
  benchmarkInstanceType: "c7i.2xlarge",
  benchmarkNodeCount: 12,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

test("deduplicates comments while preserving immutable refs", () => {
  const database = new JobDatabase(":memory:");
  try {
    assert.equal(database.enqueue(JOB), 1);
    assert.equal(database.enqueue(JOB), null);
    assert.equal(database.isCommentSeen(JOB.commentId), true);
    const queued = database.getJobForComment(JOB.commentId);
    assert.equal(queued?.dataset, "tpch/sf1");
    assert.equal(queued?.benchmarkInstanceType, "c7i.2xlarge");
    assert.equal(queued?.benchmarkNodeCount, 12);
    assert.equal(queued?.baseSha, JOB.baseSha);
    assert.equal(queued?.headSha, JOB.headSha);
  } finally {
    database.close();
  }
});

test("claims a pending job atomically", () => {
  const database = new JobDatabase(":memory:");
  try {
    const jobId = database.enqueue(JOB)!;
    assert.equal(database.claimNextPending(), null);
    database.setStatusCommentId(jobId, 77);
    assert.equal(database.claimNextPending()?.status, "running");
    assert.equal(database.claimNextPending(), null);
  } finally {
    database.close();
  }
});

test("recovers a job interrupted while running", () => {
  const database = new JobDatabase(":memory:");
  try {
    const jobId = database.enqueue(JOB)!;
    database.setStatusCommentId(jobId, 77);
    assert.equal(database.claimNextPending()?.status, "running");
    assert.deepEqual(database.recoverRunningJobs(), { retried: 1, failed: [] });
    assert.equal(database.claimNextPending()?.status, "running");
  } finally {
    database.close();
  }
});

test("fails a job after three interrupted attempts", () => {
  const database = new JobDatabase(":memory:");
  try {
    const jobId = database.enqueue(JOB)!;
    database.setStatusCommentId(jobId, 77);
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(database.claimNextPending()?.status, "running");
      const recovery = database.recoverRunningJobs();
      assert.equal(recovery.failed.length, attempt === 2 ? 1 : 0);
    }
    assert.equal(database.nextPending(), null);
  } finally {
    database.close();
  }
});

test("backs off repeated comment failures", () => {
  const database = new JobDatabase(":memory:");
  try {
    const now = new Date("2026-08-10T00:00:00.000Z");
    assert.equal(database.recordCommentFailure(7, "temporary", now), 1);
    assert.equal(database.canAttemptComment(7, now), false);
    assert.equal(
      database.canAttemptComment(7, new Date(now.getTime() + 30_000)),
      true,
    );
  } finally {
    database.close();
  }
});

test("caps active jobs per requester", () => {
  const database = new JobDatabase(":memory:");
  try {
    for (let index = 0; index < 3; index++) {
      database.enqueue({ ...JOB, commentId: 100 + index });
    }
    assert.throws(
      () => database.enqueue({ ...JOB, commentId: 200 }),
      QueueLimitError,
    );
    assert.equal(database.isCommentSeen(200), false);
  } finally {
    database.close();
  }
});
