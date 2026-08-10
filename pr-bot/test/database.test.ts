import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { JobDatabase, QueueLimitError, type NewJob } from "../src/database.js";

const JOB: NewJob = {
  commentId: 42,
  repository: "datafusion-contrib/datafusion-distributed",
  pullRequestNumber: 123,
  pullRequestUrl:
    "https://github.com/datafusion-contrib/datafusion-distributed/pull/123",
  requestedBy: "maintainer",
  datasets: ["tpch/sf1", "tpch/sf10", "tpch/sf100"],
  benchmarkInstanceType: "c7i.2xlarge",
  benchmarkNodeCount: 12,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

function unversionedDatabase(): string {
  const root = mkdtempSync(path.join(tmpdir(), "job-database-migration-"));
  const databasePath = path.join(root, "jobs.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE seen_comments (
      comment_id INTEGER PRIMARY KEY,
      seen_at TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL UNIQUE,
      repository TEXT NOT NULL,
      pull_request_number INTEGER NOT NULL,
      pull_request_url TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      dataset TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (comment_id) REFERENCES seen_comments(comment_id)
    );
  `);
  database
    .prepare("INSERT INTO seen_comments(comment_id, seen_at) VALUES (?, ?)")
    .run(JOB.commentId, "2026-08-10T00:00:00.000Z");
  database
    .prepare(
      `INSERT INTO jobs(
         comment_id, repository, pull_request_number, pull_request_url,
         requested_by, dataset, base_sha, head_sha, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      JOB.commentId,
      JOB.repository,
      JOB.pullRequestNumber,
      JOB.pullRequestUrl,
      JOB.requestedBy,
      JOB.datasets[0]!,
      JOB.baseSha,
      JOB.headSha,
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    );
  database.close();
  return databasePath;
}

test("deduplicates comments while preserving immutable refs", () => {
  const database = new JobDatabase(":memory:");
  try {
    assert.equal(database.enqueue(JOB), 1);
    assert.equal(database.enqueue(JOB), null);
    assert.equal(database.isCommentSeen(JOB.commentId), true);
    const queued = database.getJobForComment(JOB.commentId);
    assert.deepEqual(queued?.datasets, JOB.datasets);
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

test("migrates an unversioned database away from the legacy dataset column", () => {
  const databasePath = unversionedDatabase();
  const database = new JobDatabase(databasePath);
  try {
    assert.deepEqual(database.getJobForComment(JOB.commentId)?.datasets, [
      JOB.datasets[0],
    ]);
    assert.equal(
      database.getJobForComment(JOB.commentId)?.benchmarkInstanceType,
      "c5n.2xlarge",
    );
    assert.equal(
      database.getJobForComment(JOB.commentId)?.benchmarkNodeCount,
      12,
    );
  } finally {
    database.close();
  }

  const migrated = new DatabaseSync(databasePath);
  try {
    const columns = migrated.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
      notnull: number;
    }[];
    assert.equal(
      columns.some(({ name }) => name === "dataset"),
      false,
    );
    assert.equal(
      columns.find(({ name }) => name === "datasets_json")?.notnull,
      1,
    );
    assert.deepEqual(
      (
        migrated
          .prepare("SELECT version FROM schema_version ORDER BY version")
          .all() as { version: number }[]
      ).map(({ version }) => version),
      [1, 2],
    );
    assert.throws(() =>
      migrated
        .prepare("UPDATE jobs SET datasets_json = ? WHERE comment_id = ?")
        .run("not-json", JOB.commentId),
    );
  } finally {
    migrated.close();
  }
});

test("does not reapply completed database migrations", () => {
  const databasePath = unversionedDatabase();
  new JobDatabase(databasePath).close();
  new JobDatabase(databasePath).close();

  const database = new DatabaseSync(databasePath);
  try {
    assert.equal(
      Number(
        (
          database.prepare("SELECT COUNT(*) AS count FROM jobs").get() as {
            count: number;
          }
        ).count,
      ),
      1,
    );
    assert.equal(
      Number(
        (
          database
            .prepare("SELECT COUNT(*) AS count FROM schema_version")
            .get() as { count: number }
        ).count,
      ),
      2,
    );
  } finally {
    database.close();
  }
});
