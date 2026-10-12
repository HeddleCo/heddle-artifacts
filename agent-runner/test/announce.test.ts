// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAnnouncement, MAX_ANNOUNCEMENT } from "../src/announce.ts";

test("closing messages drop leaked chat-template tokens and keep the agent's words", () => {
  assert.equal(cleanAnnouncement("<|channel|>final   All tests passed.   <|return|>"), "All tests passed.");
  assert.equal(cleanAnnouncement("Uses `a|b` and <b>html</b>"), "Uses `a|b` and <b>html</b>");
  assert.equal(cleanAnnouncement("x".repeat(MAX_ANNOUNCEMENT + 1000)).length, MAX_ANNOUNCEMENT);
});
