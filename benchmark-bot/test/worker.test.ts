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
  benchmarkInstanceType: "m5.2xlarge",
  benchmarkNodeCount: 12,
  baseKind: "pull-request",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

const TIMINGS = {
  validationMs: 2_000,
  baseDeployMs: 122_000,
  baseBenchmarks: [
    { dataset: "tpch/sf1", durationMs: 10_000 },
    { dataset: "tpch/sf10", durationMs: 20_000 },
    { dataset: "tpch/sf100", durationMs: 30_000 },
  ],
  headDeployMs: 125_000,
  headBenchmarks: [
    { dataset: "tpch/sf1", durationMs: 11_000 },
    { dataset: "tpch/sf10", durationMs: 21_000 },
    { dataset: "tpch/sf100", durationMs: 31_000 },
  ],
  totalMs: 420_000,
};

const COMPARISON = `=== Comparing tpch/sf1 results 'base' [prev] with 'head' [new] ===
      q1: prev= 100 ms, new= 120 ms, diff=1.20 slower ✖
      q2: prev= 200 ms, new= 150 ms, diff=1.33 faster ✔
q3: Previously succeeded, but now failed ❌: Execution failed: <worker> & Broken pipe
q4: Previously failed, and now also failed ❌: Connection refused
   TASKS: prev=20.0, new=18.0, diff=2.0 fewer (10.0%) (sum of per-query averages)
   TOTAL: prev=300 ms, new=270 ms, diff=1.11 faster ✅`;

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
    const jobId = database.enqueue({
      ...JOB,
      headConfigs: ["distributed.collect_dynamic_filters=false"],
    })!;
    database.setStatusCommentId(jobId, 77);
    const worker = new JobWorker(database, github, {
      execute: async (_job, onProgress) => {
        await onProgress?.({
          step: 3,
          totalSteps: 10,
          message: "Deploying the base revision",
        });
        return {
          comparison: COMPARISON,
          timings: TIMINGS,
        };
      },
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.match(comments[0]!, /Running/);
    assert.match(comments[0]!, /How to use the benchmark bot/);
    assert.match(comments[0]!, /Baseline: PR base/);
    assert.match(comments[0]!, /`tpch\/sf1`, `tpch\/sf10`, `tpch\/sf100`/);
    assert.match(comments[0]!, /12 `m5\.2xlarge` nodes/);
    assert.match(
      comments[0]!,
      /PR-head configs: `distributed\.collect_dynamic_filters=false`/,
    );
    assert.match(comments[1]!, /Progress 3\/10/);
    assert.match(comments[1]!, /Deploying the base revision/);
    assert.equal(
      comments[1]!.match(/How to use the benchmark bot/g)?.length,
      1,
    );
    assert.match(comments[2]!, /TOTAL: prev=300 ms, new=270 ms/);
    assert.match(comments[2]!, /TASKS: prev=20\.0, new=18\.0/);
    assert.match(comments[2]!, /TASKS:.*TOTAL:.*<\/pre>\s*<details>/s);
    assert.match(comments[2]!, /Show full query output/);
    assert.match(
      comments[2]!,
      /q3: Previously succeeded, but now failed ❌: Execution failed: &lt;worker&gt; &amp; Broken pipe/,
    );
    assert.match(
      comments[2]!,
      /q4: Previously failed, and now also failed ❌: Connection refused/,
    );
    assert.equal(comments[2]!.match(/=== Comparing/g)?.length, 1);
    assert.equal(comments[2]!.match(/TOTAL:/g)?.length, 1);
    assert.match(comments[2]!, /q1: prev= 100 ms/);
    assert.match(comments[2]!, /pull\/99#issuecomment-7/);
    assert.match(comments[2]!, /Benchmark results/);
    assert.match(
      comments[2]!,
      /PR base `aaaaaaaaaaaa`.*PR head `bbbbbbbbbbbb`/s,
    );
    assert.match(comments[2]!, /compare\/a{40}\.\.\.b{40}/);
    assert.match(comments[2]!, /Verification and run details/);
    assert.match(comments[2]!, /detached HEAD/);
    assert.match(
      comments[2]!,
      /datafusion-distributed-remote-worker --bin worker/,
    );
    assert.match(comments[2]!, /1 warmup \+ 5 measured iterations per query/);
    assert.match(
      comments[2]!,
      /\*\*PR-head configs:\*\* `distributed\.collect_dynamic_filters=false`/,
    );
    assert.match(comments[2]!, /Build and deployment \| 2m 2s \| 2m 5s/);
    assert.match(comments[2]!, /Benchmark `tpch\/sf100` \| 30s \| 31s/);
    assert.match(comments[2]!, /Total 7m 0s/);
    assert.match(comments[2]!, /Query selection and iteration overrides/);
    assert.deepEqual(commentIds, [77, 77, 77]);
  } finally {
    database.close();
  }
});

test("labels an explicitly selected main baseline", async () => {
  const database = new JobDatabase(":memory:");
  const comments: string[] = [];
  const github = {
    updateComment: async (_repo: string, _commentId: number, body: string) => {
      comments.push(body);
    },
  } as GitHubApi;
  try {
    const jobId = database.enqueue({ ...JOB, baseKind: "main" })!;
    database.setStatusCommentId(jobId, 77);
    const worker = new JobWorker(database, github, {
      execute: async () => ({ comparison: COMPARISON, timings: TIMINGS }),
    });

    await worker.runOnce();
    assert.match(comments[0]!, /Baseline: Main/);
    assert.match(comments[1]!, /Main `aaaaaaaaaaaa`.*PR head `bbbbbbbbbbbb`/s);
    assert.match(comments[1]!, /\| Identity \| Main \| PR head \|/);
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
    assert.match(comments[1]!, /How to use the benchmark bot/);
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
        return { comparison: COMPARISON, timings: TIMINGS };
      },
    });

    assert.equal(await worker.runOnce(), true);
    assert.equal(database.getJobForComment(JOB.commentId)?.status, "completed");
    assert.match(comments.at(-1)!, /TOTAL: prev=300 ms/);
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

test("keeps escaped multi-dataset output within GitHub's comment limit", async () => {
  const database = new JobDatabase(":memory:");
  const comments: string[] = [];
  const github = {
    updateComment: async (_repo: string, _commentId: number, body: string) => {
      comments.push(body);
    },
  } as GitHubApi;
  const comparison = JOB.datasets
    .map(
      (
        dataset,
      ) => `=== Comparing ${dataset} results 'base' [prev] with 'head' [new] ===
${Array.from({ length: 100 }, (_, index) => `q${index + 1}: Previously succeeded, but now failed ❌: ${"&<>".repeat(99)}…`).join("\n")}
   TOTAL: prev=300 ms, new=270 ms, diff=1.11 faster`,
    )
    .join("\n\n");
  try {
    const jobId = database.enqueue(JOB)!;
    database.setStatusCommentId(jobId, 77);
    const worker = new JobWorker(database, github, {
      execute: async () => ({ comparison, timings: TIMINGS }),
    });

    await worker.runOnce();

    const result = comments[1]!;
    assert.ok(result.length <= 65_536);
    assert.match(result, /earlier output truncated/);
    assert.equal(
      result.match(/<details>/g)?.length,
      result.match(/<\/details>/g)?.length,
    );
    assert.equal(
      result.match(/<pre>/g)?.length,
      result.match(/<\/pre>/g)?.length,
    );
    for (const dataset of JOB.datasets) {
      assert.ok(result.includes(`=== Comparing ${dataset}`));
    }
    assert.equal(
      result.match(/TOTAL: prev=300 ms/g)?.length,
      JOB.datasets.length,
    );
    assert.match(result, /Verification and run details/);
    assert.match(result, /How to use the benchmark bot/);
    assert.match(result, /&amp;&lt;&gt;/);
    assert.doesNotMatch(result, /q1: &<>/);
  } finally {
    database.close();
  }
});
