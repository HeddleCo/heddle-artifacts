// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import Ajv from "ajv";
import { createReviewer, REVIEW_MODEL, REVIEW_SCHEMA, type ReviewInput } from "../reviewer";
const validates = new Ajv().compile(REVIEW_SCHEMA);
for (const count of [1, 2, 3]) {
  it(`D-T2 validates ${count} candidates`, async () => {
    const input: ReviewInput = { intent: "Support escaped pipes", base: "base", turns: [],
      candidates: Array.from({ length: count }, (_, i) => ({ agent: `agent-${i}`, diff: "+parseRow",
        tests: { status: "pass", passed: 14, failed: 0, summary: "14 pass", durationMs: 50 } })) };
    const response = { summary: "Preserves the API", perCandidate: input.candidates.map(c =>
      ({ agent: c.agent, verdict: "approve", notes: "Tests pass" })),
      recommendation: { pick: "agent-0", why: "Preserves string[]" }, model: REVIEW_MODEL };
    const result = await createReviewer({ AI: { run: async () => ({ response: JSON.stringify(response) }) } })(input);
    expect(result).toEqual(response); expect(validates(result)).toBe(true);
  });
}
it("D-T2 AI failure is labeled fallback", async () => {
  const result = await createReviewer({ AI: { run: async () => { throw new Error("forced AI failure"); } } })
    ({ intent: "test", base: "base", candidates: [], turns: [] });
  expect(result.model).toBe("fallback"); expect(validates(result)).toBe(true);
});
