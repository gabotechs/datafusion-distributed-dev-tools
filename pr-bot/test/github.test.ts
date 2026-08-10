import assert from "node:assert/strict";
import test from "node:test";

import { GitHubClient } from "../src/github.js";

interface RecordedRequest {
  input: string | URL | Request;
  init: RequestInit | undefined;
}

function recordingFetch(responses: Response[]) {
  const requests: RecordedRequest[] = [];
  const fetch_: typeof fetch = async (input, init) => {
    requests.push({ input, init });
    const response = responses.shift();
    assert.ok(response, "unexpected GitHub API request");
    return response;
  };
  return { fetch_, requests };
}

test("lists every page of issue comments with token authentication", async () => {
  const next =
    "https://api.github.com/repos/owner/repository/issues/comments?per_page=100&page=2";
  const { fetch_, requests } = recordingFetch([
    Response.json([{ id: 1, body: "first" }], {
      headers: { link: `<${next}>; rel="next"` },
    }),
    Response.json([{ id: 2, body: "second" }]),
  ]);

  const comments = await new GitHubClient(
    "secret-token",
    fetch_,
  ).listIssueComments("owner/repository", "2026-08-10T00:00:00.000Z");

  assert.deepEqual(
    comments.map((comment) => comment.id),
    [1, 2],
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.input, next);
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("authorization"),
    "Bearer secret-token",
  );
});

test("posts comments as JSON without invoking a subprocess", async () => {
  const { fetch_, requests } = recordingFetch([Response.json({ id: 7 })]);
  const body = "result $(do-not-expand)";

  await new GitHubClient("secret-token", fetch_).postComment(
    "owner/repository",
    42,
    body,
  );

  assert.equal(
    requests[0]?.input,
    "https://api.github.com/repos/owner/repository/issues/42/comments",
  );
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[0]?.init?.body, JSON.stringify({ body }));
});

test("reports API failures without exposing the token", async () => {
  const { fetch_ } = recordingFetch([
    new Response("bad credentials", { status: 401 }),
  ]);

  await assert.rejects(
    new GitHubClient("do-not-log-this", fetch_).getPullRequest(
      "owner/repository",
      42,
    ),
    (error: Error) => {
      assert.match(error.message, /GitHub API GET .* failed: 401/);
      assert.doesNotMatch(error.message, /do-not-log-this/);
      return true;
    },
  );
});
