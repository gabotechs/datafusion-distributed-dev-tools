import { createSign } from "node:crypto";

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

interface InstallationToken {
  token: string;
  expiresAt: number;
}

const API = "https://api.github.com";

export class GitHubClient {
  #installationToken?: InstallationToken;

  constructor(
    readonly appId: string,
    readonly installationId: string,
    readonly privateKey: string,
  ) {}

  async listIssueComments(
    repository: string,
    since: string,
  ): Promise<IssueComment[]> {
    let url: string | null =
      `${API}/repos/${repository}/issues/comments?per_page=100&sort=updated&direction=asc&since=${encodeURIComponent(since)}`;
    const comments: IssueComment[] = [];
    for (let page = 0; url && page < 100; page++) {
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
      `${API}/repos/${repository}/pulls/${number}`,
    );
    return (await response.json()) as PullRequest;
  }

  async hasWritePermission(
    repository: string,
    login: string,
  ): Promise<boolean> {
    const response = await this.request(
      `${API}/repos/${repository}/collaborators/${login}/permission`,
    );
    const { permission } = (await response.json()) as { permission: string };
    return ["admin", "maintain", "write"].includes(permission);
  }

  async postComment(
    repository: string,
    pullRequestNumber: number,
    body: string,
  ): Promise<void> {
    await this.request(
      `${API}/repos/${repository}/issues/${pullRequestNumber}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "datafusion-distributed-pr-bot",
        "x-github-api-version": "2022-11-28",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub API ${init.method ?? "GET"} ${url} failed: ${response.status} ${await response.text()}`,
      );
    }
    return response;
  }

  async token(): Promise<string> {
    const now = Date.now();
    if (
      this.#installationToken &&
      this.#installationToken.expiresAt > now + 60_000
    ) {
      return this.#installationToken.token;
    }
    const response = await fetch(
      `${API}/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${appJwt(this.appId, this.privateKey)}`,
          "content-type": "application/json",
          "user-agent": "datafusion-distributed-pr-bot",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub installation token failed: ${response.status} ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as {
      token: string;
      expires_at: string;
    };
    this.#installationToken = {
      token: payload.token,
      expiresAt: Date.parse(payload.expires_at),
    };
    return payload.token;
  }
}

export function appJwt(
  appId: string,
  privateKey: string,
  now = Date.now(),
): string {
  const issuedAt = Math.floor(now / 1_000) - 60;
  const header = encodedJson({ alg: "RS256", typ: "JWT" });
  const payload = encodedJson({
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: appId,
  });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

function encodedJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}
