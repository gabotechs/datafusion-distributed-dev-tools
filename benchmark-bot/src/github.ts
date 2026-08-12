export interface IssueComment {
  id: number;
  body: string;
  issue_url: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string };
}

export interface PullRequest {
  number: number;
  html_url: string;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
}

export interface GitHubApi {
  listIssueComments(repository: string, since: string): Promise<IssueComment[]>;
  getPullRequest(repository: string, number: number): Promise<PullRequest>;
  postComment(
    repository: string,
    pullRequestNumber: number,
    body: string,
  ): Promise<number>;
  updateComment(
    repository: string,
    commentId: number,
    body: string,
  ): Promise<void>;
}

type Fetch = typeof fetch;

const GITHUB_API = "https://api.github.com";
const GITHUB_PAGE_SIZE = 100;
const MAX_GITHUB_PAGES = 100;

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    url: string,
    responseBody: string,
  ) {
    super(`GitHub API ${method} ${url} failed: ${status} ${responseBody}`);
  }
}

export class GitHubClient implements GitHubApi {
  constructor(
    readonly token: string,
    readonly fetchImpl: Fetch = fetch,
  ) {}

  async listIssueComments(
    repository: string,
    since: string,
  ): Promise<IssueComment[]> {
    let url: string | null =
      `${GITHUB_API}/repos/${repositoryPath(repository)}/issues/comments?per_page=${GITHUB_PAGE_SIZE}&sort=updated&direction=asc&since=${encodeURIComponent(since)}`;
    const comments: IssueComment[] = [];
    for (let page = 0; url && page < MAX_GITHUB_PAGES; page++) {
      const response = await this.request(url);
      comments.push(...((await response.json()) as IssueComment[]));
      url = nextLink(response.headers.get("link"));
    }
    return comments;
  }

  async getPullRequest(
    repository: string,
    number: number,
  ): Promise<PullRequest> {
    const response = await this.request(
      `${GITHUB_API}/repos/${repositoryPath(repository)}/pulls/${number}`,
    );
    return (await response.json()) as PullRequest;
  }

  async postComment(
    repository: string,
    pullRequestNumber: number,
    body: string,
  ): Promise<number> {
    const response = await this.request(
      `${GITHUB_API}/repos/${repositoryPath(repository)}/issues/${pullRequestNumber}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    const comment = (await response.json()) as { id: number };
    return comment.id;
  }

  async updateComment(
    repository: string,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.request(
      `${GITHUB_API}/repos/${repositoryPath(repository)}/issues/comments/${commentId}`,
      { method: "PATCH", body: JSON.stringify({ body }) },
    );
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": "datafusion-distributed-benchmark-bot",
        "x-github-api-version": "2026-03-10",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        init.method ?? "GET",
        url,
        await response.text(),
      );
    }
    return response;
  }
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid GitHub repository ${repository}`);
  }
  return parts.map(encodeURIComponent).join("/");
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}
