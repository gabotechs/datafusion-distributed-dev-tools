import assert from "node:assert/strict";
import test from "node:test";

import { waitForNextPoll } from "../src/poll-wait.js";

test("an aborted polling wait resolves immediately", async () => {
  const started = Date.now();
  await waitForNextPoll(60_000, AbortSignal.abort());
  assert.ok(Date.now() - started < 1_000);
});
