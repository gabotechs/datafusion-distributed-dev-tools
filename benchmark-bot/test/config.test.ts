import assert from "node:assert/strict";
import test from "node:test";

import {
  loadAuthorizedGithubLogins,
  parseAuthorizedGithubLogins,
} from "../infra/config.js";

test("parses one authorized GitHub login per non-empty line", () => {
  assert.deepEqual(
    parseAuthorizedGithubLogins("first-user\n\n second-user \r\n"),
    ["first-user", "second-user"],
  );
});

test("loads the committed authorized GitHub logins", () => {
  const logins = loadAuthorizedGithubLogins();
  assert.ok(logins.length > 0);
  assert.ok(
    logins.every((login) =>
      /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login),
    ),
  );
});
