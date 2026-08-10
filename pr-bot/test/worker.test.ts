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
  datasets: ["tpch/sf1", "tpch/sf10", "tpch/sf100"],
  benchmarkInstanceType: "c7i.2xlarge",
  benchmarkNodeCount: 12,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

const TIMINGS = {
  validationMs: 2_000,
  baseCompileMs: 61_000,
  baseDeployMs: 122_000,
  baseBenchmarks: [
    { dataset: "tpch/sf1", durationMs: 10_000 },
    { dataset: "tpch/sf10", durationMs: 20_000 },
    { dataset: "tpch/sf100", durationMs: 30_000 },
  ],
  headCompileMs: 65_000,
  headDeployMs: 125_000,
  headBenchmarks: [
    { dataset: "tpch/sf1", durationMs: 11_000 },
    { dataset: "tpch/sf10", durationMs: 21_000 },
    { dataset: "tpch/sf100", durationMs: 31_000 },
  ],
  totalMs: 420_000,
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
      execute: async (_job, onProgress) => {
        await onProgress?.({
          step: 3,
          totalSteps: 13,
          message: "Compiling the base revision",
        });
        return {
          comparison: "TOTAL: 1.20 faster",
          timings: TIMINGS,
        };
      },
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.match(comments[0]!, /Running/);
    assert.match(comments[0]!, /`tpch\/sf1`, `tpch\/sf10`, `tpch\/sf100`/);
    assert.match(comments[0]!, /12 `c7i\.2xlarge` nodes/);
    assert.match(comments[1]!, /Progress 3\/13/);
    assert.match(comments[1]!, /Compiling the base revision/);
    assert.match(comments[2]!, /TOTAL: 1.20 faster/);
    assert.match(comments[2]!, /pull\/99#issuecomment-7/);
    assert.match(comments[2]!, /Run metadata/);
    assert.match(comments[2]!, /Compilation \| 1m 1s \| 1m 5s/);
    assert.match(comments[2]!, /Kubernetes provisioning \| 2m 2s \| 2m 5s/);
    assert.match(comments[2]!, /Benchmark `tpch\/sf100` \| 30s \| 31s/);
    assert.match(comments[2]!, /Total: 7m 0s/);
    assert.deepEqual(commentIds, [77, 77, 77]);
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

test("continues the benchmark when a progress edit fails", async () => {
  const database = new JobDatabase(":memory:");
  const comments: string[] = [];
  let updateCount = 0;
  const github = {
    updateComment: async (_repo: string, _commentId: number, body: string) => {
      updateCount += 1;
      if (updateCount === 2) throw new Error("temporary GitHub failure");
      comments.push(body);
    },
  } as GitHubApi;
  try {
    const jobId = database.enqueue(JOB)!;
    database.setStatusCommentId(jobId, 77);
    const worker = new JobWorker(database, github, {
      execute: async (_job, onProgress) => {
        await onProgress?.({
          step: 1,
          totalSteps: 13,
          message: "Validating all requested datasets",
        });
        return { comparison: "TOTAL: 1.20 faster", timings: TIMINGS };
      },
    });

    assert.equal(await worker.runOnce(), true);
    assert.equal(database.getJobForComment(JOB.commentId)?.status, "completed");
    assert.match(comments.at(-1)!, /TOTAL: 1.20 faster/);
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
      execute: async () => ({
        comparison: "</pre><script>alert(1)</script>",
        timings: TIMINGS,
      }),
    });
    await worker.runOnce();
    assert.match(comments[1]!, /&lt;script&gt;/);
    assert.doesNotMatch(comments[1]!, /<script>/);
  } finally {
    database.close();
  }
});
