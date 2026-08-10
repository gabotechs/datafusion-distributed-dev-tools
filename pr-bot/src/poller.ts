import { parseComment } from "./command.js";
import { JobDatabase, QueueLimitError } from "./database.js";
import type { GitHubApi, IssueComment } from "./github.js";

const INITIAL_LOOKBACK_MS = 60 * 60 * 1_000;
const SCAN_OVERLAP_MS = 2 * 60 * 1_000;
const MAX_COMMENT_ATTEMPTS = 3;

export class CommentPoller {
  constructor(
    readonly repository: string,
    readonly database: JobDatabase,
    readonly github: GitHubApi,
  ) {}

  async poll(now = new Date()): Promise<void> {
    const since =
      this.database.getScanTime(this.repository) ??
      new Date(now.getTime() - INITIAL_LOOKBACK_MS).toISOString();
    const comments = await this.github.listIssueComments(
      this.repository,
      since,
    );
    let watermarkBlocked = false;
    for (const comment of comments) {
      const terminal = await this.processSafely(comment, now);
      if (!terminal) watermarkBlocked = true;
      if (terminal && !watermarkBlocked) {
        this.advanceScanTime(comment.updated_at ?? comment.created_at);
      }
    }
    if (!watermarkBlocked) {
      this.database.setScanTime(
        this.repository,
        new Date(now.getTime() - SCAN_OVERLAP_MS).toISOString(),
      );
    }
  }

  async processSafely(comment: IssueComment, now: Date): Promise<boolean> {
    if (this.database.isCommentSeen(comment.id)) return true;
    if (!this.database.canAttemptComment(comment.id, now)) return false;
    try {
      await this.process(comment);
      this.database.clearCommentFailure(comment.id);
      return true;
    } catch (error) {
      console.error(`Failed to process GitHub comment ${comment.id}`, error);
      if (this.database.isCommentSeen(comment.id)) return true;
      const message = error instanceof Error ? error.message : String(error);
      const attempts = this.database.recordCommentFailure(
        comment.id,
        message,
        now,
      );
      if (attempts < MAX_COMMENT_ATTEMPTS) return false;
      this.database.markCommentSeen(comment.id, now);
      console.error(
        `Dropping GitHub comment ${comment.id} after ${attempts} attempts`,
      );
      return true;
    }
  }

  async process(comment: IssueComment): Promise<void> {
    if (this.database.isCommentSeen(comment.id)) return;

    const parsed = parseComment(comment.body);
    if (parsed.kind === "none") {
      this.database.markCommentSeen(comment.id);
      return;
    }
    const pullRequestNumber = issueNumber(comment.issue_url);
    if (!pullRequestNumber) {
      this.database.markCommentSeen(comment.id);
      return;
    }
    const allowed = await this.github.hasWritePermission(
      this.repository,
      comment.user.login,
    );
    if (!allowed) {
      this.database.markCommentSeen(comment.id);
      return;
    }
    if (parsed.kind === "invalid") {
      await this.github.postComment(
        this.repository,
        pullRequestNumber,
        `@${comment.user.login} ${parsed.message}`,
      );
      this.database.markCommentSeen(comment.id);
      return;
    }

    const pullRequest = await this.github.getPullRequest(
      this.repository,
      pullRequestNumber,
    );
    let jobId: number | null;
    try {
      jobId = this.database.enqueue({
        commentId: comment.id,
        repository: this.repository,
        pullRequestNumber,
        pullRequestUrl: pullRequest.html_url,
        requestedBy: comment.user.login,
        dataset: parsed.request.dataset,
        benchmarkInstanceType: parsed.request.instanceType,
        benchmarkNodeCount: parsed.request.nodeCount,
        baseSha: pullRequest.base.sha,
        headSha: pullRequest.head.sha,
      });
    } catch (error) {
      if (!(error instanceof QueueLimitError)) throw error;
      this.database.markCommentSeen(comment.id);
      await this.github.postComment(
        this.repository,
        pullRequestNumber,
        `@${comment.user.login} ${error.message}; this request was not queued.`,
      );
      return;
    }
    if (jobId !== null) {
      await this.github.postComment(
        this.repository,
        pullRequestNumber,
        `Queued benchmark job ${jobId}: \`${parsed.request.dataset}\` on ${parsed.request.nodeCount} \`${parsed.request.instanceType}\` nodes, comparing base \`${shortSha(pullRequest.base.sha)}\` with head \`${shortSha(pullRequest.head.sha)}\`.`,
      );
    }
  }

  advanceScanTime(timestamp: string): void {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return;
    this.database.setScanTime(
      this.repository,
      new Date(parsed.getTime() - SCAN_OVERLAP_MS).toISOString(),
    );
  }
}

function issueNumber(issueUrl: string): number | null {
  const match = /\/issues\/(\d+)$/.exec(issueUrl);
  return match ? Number(match[1]) : null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
