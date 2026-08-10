import { parseComment } from "./command.js";
import { JobDatabase } from "./database.js";
import type { GitHubApi, IssueComment } from "./github.js";

const INITIAL_LOOKBACK_MS = 60 * 60 * 1_000;
const SCAN_OVERLAP_MS = 2 * 60 * 1_000;

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
    for (const comment of comments) {
      await this.process(comment);
    }
    this.database.setScanTime(
      this.repository,
      new Date(now.getTime() - SCAN_OVERLAP_MS).toISOString(),
    );
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
    const jobId = this.database.enqueue({
      commentId: comment.id,
      repository: this.repository,
      pullRequestNumber,
      pullRequestUrl: pullRequest.html_url,
      requestedBy: comment.user.login,
      dataset: parsed.request.dataset,
      baseSha: pullRequest.base.sha,
      headSha: pullRequest.head.sha,
    });
    if (jobId !== null) {
      await this.github.postComment(
        this.repository,
        pullRequestNumber,
        `Queued benchmark job ${jobId}: \`${parsed.request.dataset}\` comparing base \`${shortSha(pullRequest.base.sha)}\` with head \`${shortSha(pullRequest.head.sha)}\`.`,
      );
    }
  }
}

function issueNumber(issueUrl: string): number | null {
  const match = /\/issues\/(\d+)$/.exec(issueUrl);
  return match ? Number(match[1]) : null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
