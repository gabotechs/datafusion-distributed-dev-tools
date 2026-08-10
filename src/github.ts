import type { ProcessRunner } from "./process.js";

export interface IssueComment {
  id: number;
  body: string;
  issue_url: string;
  html_url: string;
  created_at: string;
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
  hasWritePermission(repository: string, login: string): Promise<boolean>;
  postComment(
    repository: string,
    pullRequestNumber: number,
    body: string,
  ): Promise<void>;
}

export class GhCliClient implements GitHubApi {
  constructor(readonly processes: ProcessRunner) {}

  async listIssueComments(
    repository: string,
    since: string,
  ): Promise<IssueComment[]> {
    const endpoint = `/repos/${repository}/issues/comments?per_page=100&sort=updated&direction=asc&since=${encodeURIComponent(since)}`;
    const pages = await this.json<IssueComment[][]>([
      "api",
      "--paginate",
      "--slurp",
      endpoint,
    ]);
    return pages.flat();
  }

  async getPullRequest(
    repository: string,
    number: number,
  ): Promise<PullRequest> {
    return await this.json<PullRequest>([
      "api",
      `/repos/${repository}/pulls/${number}`,
    ]);
  }

  async hasWritePermission(
    repository: string,
    login: string,
  ): Promise<boolean> {
    const result = await this.json<{ permission: string }>([
      "api",
      `/repos/${repository}/collaborators/${login}/permission`,
    ]);
    return ["admin", "maintain", "write"].includes(result.permission);
  }

  async postComment(
    repository: string,
    pullRequestNumber: number,
    body: string,
  ): Promise<void> {
    await this.processes.run(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `/repos/${repository}/issues/${pullRequestNumber}/comments`,
        "--field",
        `body=${body}`,
      ],
      { quiet: true },
    );
  }

  async json<T>(arguments_: string[]): Promise<T> {
    const result = await this.processes.run("gh", arguments_, { quiet: true });
    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      throw new Error(`gh returned invalid JSON: ${String(error)}`);
    }
  }
}
