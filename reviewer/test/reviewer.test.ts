// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import Ajv from "ajv";
import { createReviewer, REVIEW_MODEL, REVIEW_SCHEMA, REVIEW_TIMEOUT_MS, type ReviewInput } from "../reviewer";
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

const conflictInput: ReviewInput = { intent: "Support escaped pipes", base: "base", turns: [], candidates: [
  { agent: "alice", diff: "+regex split", tests: { status: "fail", passed: 15, failed: 3, summary: "parity fails", durationMs: 10 } },
  { agent: "bob", diff: "+scanner", tests: { status: "pass", passed: 18, failed: 0, summary: "18 pass", durationMs: 10 } },
] };
const good = { summary: "Bob handles parity", perCandidate: [
  { agent: "alice", verdict: "concerns", notes: "parity fails" },
  { agent: "bob", verdict: "approve", notes: "18 tests pass" },
], recommendation: { pick: "bob", why: "parity and API" }, model: REVIEW_MODEL };

it("retries malformed JSON twice, then succeeds on attempt three", async () => {
  let calls = 0;
  const result = await createReviewer({ AI: { run: async (model, payload) => {
    expect(model).toBe(REVIEW_MODEL);
    expect(payload.response_format).toEqual({ type: "json_schema", json_schema: REVIEW_SCHEMA });
    calls++; return { response: calls < 3 ? "bad json" : JSON.stringify(good) };
  } } })(conflictInput);
  expect(calls).toBe(3); expect(result).toEqual(good);
});
for (const [name, invalid] of [
  ["extra properties", { ...good, tool: "land" }],
  ["unknown pick", { ...good, recommendation: { pick: "mallory", why: "unknown" } }],
  ["duplicate verdict", { ...good, perCandidate: [good.perCandidate[0], good.perCandidate[0]] }],
  ["missing candidate", { ...good, perCandidate: [good.perCandidate[1]] }],
  ["failing recommendation", { ...good, recommendation: { pick: "alice", why: "ignores failures" } }],
  ["model spoof", { ...good, model: "untrusted-model" }],
  ["blank summary", { ...good, summary: " " }],
] as const) {
  it(`rejects ${name}, exhausts exactly two retries, returns valid fallback`, async () => {
    let calls = 0;
    const result = await createReviewer({ AI: { run: async () => { calls++; return { response: invalid }; } } })(conflictInput);
    expect(calls).toBe(3); expect(result.model).toBe("fallback");
    expect(result.perCandidate.map(c => c.agent)).toEqual(["alice", "bob"]);
    expect(result.recommendation).toBeUndefined(); expect(validates(result)).toBe(true);
  });
}
it("AI errors fallback immediately, never expose error contents", async () => {
  let calls = 0;
  const result = await createReviewer({ AI: { run: async () => { calls++; throw new Error("private diagnostic"); } } })(conflictInput);
  expect(calls).toBe(1); expect(result.model).toBe("fallback");
  expect(JSON.stringify(result)).not.toContain("private diagnostic"); expect(validates(result)).toBe(true);
});
it("rejects duplicate input agents before invoking AI", async () => {
  let calls = 0;
  await expect(createReviewer({ AI: { run: async () => { calls++; return {}; } } })
    ({ ...conflictInput, candidates: [conflictInput.candidates[0], conflictInput.candidates[0]] })).rejects.toThrow("distinct");
  expect(calls).toBe(0);
});
it("bounds diff/log context and keeps evidence inside a user message", async () => {
  await createReviewer({ AI: { run: async (_model, payload) => {
    const messages = payload.messages as Array<{ role: string; content: string }>;
    const context = JSON.parse(messages[1].content);
    expect(context.candidates[0].diff).toHaveLength(4000);
    expect(context.candidates[0].truncated).toBe(true);
    expect(messages[0].content).toContain("untrusted evidence");
    return { response: good };
  } } })({ ...conflictInput, candidates: [{ ...conflictInput.candidates[0], diff: "x".repeat(1000000) }, conflictInput.candidates[1]] });
});

it("hung AI returns fallback after its deadline", async () => {
  vi.useFakeTimers();
  try {
    const pending = createReviewer({ AI: { run: () => new Promise(() => {}) } })(conflictInput);
    await vi.advanceTimersByTimeAsync(REVIEW_TIMEOUT_MS);
    expect((await pending).model).toBe("fallback");
  } finally { vi.useRealTimers(); }
});

it("missing AI returns a labeled fallback without a recommendation", async () => {
  const result = await createReviewer({})(conflictInput);
  expect(result.model).toBe("fallback");
  expect(result.recommendation).toBeUndefined();
  expect(result.perCandidate.map(candidate => candidate.agent)).toEqual(["alice", "bob"]);
  expect(result.perCandidate.every(candidate => candidate.verdict === "concerns")).toBe(true);
  expect(validates(result)).toBe(true);
});
