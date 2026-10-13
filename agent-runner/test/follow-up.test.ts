// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLLOW_UP_PROMPT, hasUnpushedWork } from "../src/follow-up.ts";

const clean = { statusExit: 0, status: "", aheadExit: 0, ahead: "0\n" };

test("only work that is known to be unpushed earns a follow-up turn", () => {
  assert.equal(hasUnpushedWork(clean), false, "nothing to push");
  assert.equal(hasUnpushedWork({ ...clean, status: " M languages/lua/src/grammar.ts\n?? languages/lua/test/strings.lua\n" }), true, "uncommitted changes");
  assert.equal(hasUnpushedWork({ ...clean, ahead: "3\n" }), true, "local commits not on origin");
  assert.equal(hasUnpushedWork({ ...clean, statusExit: 128, status: "fatal: not a git repository" }), false, "git could not answer");
  assert.equal(hasUnpushedWork({ ...clean, aheadExit: 128, ahead: "fatal: bad revision" }), false, "no origin/main to compare");
});

test("the follow-up asks the agent to push or explain, never pushes for it", () => {
  assert.match(FOLLOW_UP_PROMPT, /git push origin HEAD:main/);
  assert.match(FOLLOW_UP_PROMPT, /push nothing and say exactly what is missing/);
});
