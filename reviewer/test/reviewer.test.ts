// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import Ajv from "ajv";
import { createReviewer, isReview, review, REVIEW_MODEL, REVIEW_SCHEMA, REVIEW_TIMEOUT_MS, type ReviewDiagnostic, type ReviewInput,
  type ReviewModelInput, type ReviewValidationFailure } from "../reviewer";
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
    expect(payload.response_format.type).toBe("json_schema");
    expectBoundSchema(payload.response_format.json_schema, conflictInput);
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

it("guarded retry admits a valid response after 31 seconds with exactly one call", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const diagnostics: ReviewDiagnostic[] = [];
    const pending = createReviewer({ AI: { run: async (_model, payload) => {
      calls++;
      expect(payload.response_format.type).toBe("json_schema");
      expectBoundSchema(payload.response_format.json_schema, conflictInput);
      expect(payload.max_tokens).toBe(2048); expect(payload.stream).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 31000));
      return { response: JSON.stringify(good) };
    } } }, { timeoutMs: 90000, maxAttempts: 1, onDiagnostic: value => diagnostics.push(value) })(conflictInput);
    await vi.advanceTimersByTimeAsync(30000);
    expect(diagnostics.map(d => d.reason)).toEqual(["started"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual(good); expect(calls).toBe(1);
    expect(diagnostics.map(d => d.reason)).toEqual(["started", "admitted"]);
    expect(diagnostics[1]).toMatchObject({ attempt: 1, elapsedMs: 31000, timeoutMs: 90000, maxAttempts: 1, responseType: "string" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("guarded retry times out once at 90 seconds and ignores a late model result", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0, resolveAI!: (value: unknown) => void;
    const diagnostics: ReviewDiagnostic[] = [];
    const pending = createReviewer({ AI: { run: () => {
      calls++; return new Promise(resolve => { resolveAI = resolve; });
    } } })(conflictInput, { timeoutMs: 90000, maxAttempts: 1, onDiagnostic: d => diagnostics.push(d) });
    await vi.advanceTimersByTimeAsync(89999);
    expect(diagnostics.map(d => d.reason)).toEqual(["started"]);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.model).toBe("fallback"); expect(validates(result)).toBe(true);
    expect(diagnostics.map(d => d.reason)).toEqual(["started", "deadline"]);
    expect(diagnostics[1]).toMatchObject({ attempt: 1, elapsedMs: 90000, timeoutMs: 90000, maxAttempts: 1 });
    resolveAI({ response: good }); await vi.advanceTimersByTimeAsync(180000);
    expect(calls).toBe(1); expect(diagnostics).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

for (const [name, output, reason] of [
  ["missing envelope", { privateText: "secret sentinel" }, "invalid_envelope"],
  ["malformed JSON", { response: "secret sentinel" }, "malformed_json"],
  ["oversized response", { response: "x".repeat(64001) }, "response_too_large"],
  ["extra properties", { response: { ...good, privateText: "secret sentinel" } }, "invalid_review"],
  ["model spoof", { response: { ...good, model: "secret sentinel" } }, "invalid_review"],
  ["failing recommendation", { response: { ...good, recommendation: { pick: "alice", why: "secret sentinel" } } }, "invalid_review"],
  ["missing candidate", { response: { ...good, perCandidate: [good.perCandidate[1]] } }, "invalid_review"],
  ["duplicate candidate", { response: { ...good, perCandidate: [good.perCandidate[0], good.perCandidate[0]] } }, "invalid_review"],
] as const) {
  it(`guarded retry rejects ${name} after one call without exposing output`, async () => {
    let calls = 0;
    const diagnostics: ReviewDiagnostic[] = [];
    const result = await createReviewer({ AI: { run: async () => { calls++; return output; } } },
      { timeoutMs: 90000, maxAttempts: 1, onDiagnostic: d => diagnostics.push(d) })(conflictInput);
    expect(calls).toBe(1); expect(result.model).toBe("fallback"); expect(validates(result)).toBe(true);
    expect(result.recommendation).toBeUndefined();
    expect(diagnostics.map(d => d.reason)).toEqual(["started", reason]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret sentinel");
    expect(JSON.stringify(diagnostics)).not.toContain("privateText");
  });
}

it("provider failures expose only numeric status/code and never retry", async () => {
  let calls = 0;
  const diagnostics: ReviewDiagnostic[] = [];
  const error = Object.assign(new Error("secret sentinel"), { status: 408, code: "3007", privateText: "secret sentinel" });
  const result = await review(conflictInput, { AI: { run: async () => { calls++; throw error; } } },
    { onDiagnostic: d => diagnostics.push(d) });
  expect(calls).toBe(1); expect(result.model).toBe("fallback");
  expect(diagnostics.map(d => d.reason)).toEqual(["started", "provider_error"]);
  expect(diagnostics[1]).toMatchObject({ providerStatus: 408, providerCode: 3007, maxAttempts: 3, timeoutMs: REVIEW_TIMEOUT_MS });
  expect(JSON.stringify(diagnostics)).not.toContain("secret sentinel");
  expect(JSON.stringify(diagnostics)).not.toContain("privateText");
});

it("diagnostics omit nonnumeric provider fields and tolerate unsafe property access", async () => {
  for (const error of [{ status: "secret sentinel", code: "secret sentinel" },
    { get status(): never { throw new Error("secret sentinel"); } }]) {
    const diagnostics: ReviewDiagnostic[] = [];
    const result = await createReviewer({ AI: { run: async () => { throw error; } } },
      { onDiagnostic: d => diagnostics.push(d) })(conflictInput);
    expect(result.model).toBe("fallback");
    expect(diagnostics[1].providerStatus).toBeUndefined(); expect(diagnostics[1].providerCode).toBeUndefined();
    expect(JSON.stringify(diagnostics)).not.toContain("secret sentinel");
  }
});

it("a throwing diagnostic observer cannot change admission or call count", async () => {
  let calls = 0;
  const result = await createReviewer({ AI: { run: async () => { calls++; return { response: good }; } } },
    { maxAttempts: 1, onDiagnostic: () => { throw new Error("observer failure"); } })(conflictInput);
  expect(result).toEqual(good); expect(calls).toBe(1);
});

it("missing binding reports zero attempts without modifying the fallback schema", async () => {
  const diagnostics: ReviewDiagnostic[] = [];
  const result = await createReviewer({}, { onDiagnostic: d => diagnostics.push(d) })(conflictInput);
  expect(result.model).toBe("fallback"); expect(validates(result)).toBe(true);
  expect(diagnostics).toEqual([{ model: REVIEW_MODEL, reason: "missing_binding", attempt: 0, elapsedMs: 0, timeoutMs: REVIEW_TIMEOUT_MS, maxAttempts: 3 }]);
});

it("per-call options override factory options without mutating subsequent calls", async () => {
  let calls = 0;
  const factoryDiagnostics: ReviewDiagnostic[] = [], callDiagnostics: ReviewDiagnostic[] = [];
  const reviewer = createReviewer({ AI: { run: async () => { calls++; return { response: "bad json" }; } } },
    { maxAttempts: 3, onDiagnostic: d => factoryDiagnostics.push(d) });
  await reviewer(conflictInput, { maxAttempts: 1, timeoutMs: 90000, onDiagnostic: d => callDiagnostics.push(d) });
  expect(calls).toBe(1); expect(factoryDiagnostics).toHaveLength(0);
  expect(callDiagnostics.map(d => d.reason)).toEqual(["started", "malformed_json"]);
  await reviewer(conflictInput);
  expect(calls).toBe(4);
  expect(factoryDiagnostics.map(d => d.reason)).toEqual(["started", "malformed_json", "started", "malformed_json", "started", "malformed_json"]);
});

for (const options of [{ timeoutMs: 0 }, { timeoutMs: 90001 }, { timeoutMs: NaN }, { timeoutMs: 1.5 },
  { maxAttempts: 0 }, { maxAttempts: 4 }, { maxAttempts: Infinity }, { maxAttempts: 1.5 }]) {
  it(`rejects invalid execution bounds ${JSON.stringify(options)} before inference`, async () => {
    let calls = 0;
    await expect(createReviewer({ AI: { run: async () => { calls++; return { response: good }; } } }, options)(conflictInput))
      .rejects.toThrow("invalid review execution bounds");
    expect(calls).toBe(0);
  });
}

function expectBoundSchema(schema: ReviewModelInput["response_format"]["json_schema"], input: ReviewInput) {
  const agents = input.candidates.map(c => c.agent);
  const passing = input.candidates.filter(c => c.tests?.status === "pass").map(c => c.agent);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toEqual(["summary", "perCandidate", "model"]);
  expect(schema.properties.model).toEqual({ type: "string", enum: [REVIEW_MODEL] });
  expect(schema.properties.perCandidate.minItems).toBe(agents.length);
  expect(schema.properties.perCandidate.maxItems).toBe(agents.length);
  expect(schema.properties.perCandidate.items.properties.agent.enum).toEqual(agents.length ? agents : undefined);
  if (passing.length) expect(schema.properties.recommendation?.properties.pick.enum).toEqual(passing);
  else expect(schema.properties).not.toHaveProperty("recommendation");
}

async function captureSchema(input: ReviewInput) {
  let captured!: ReviewModelInput["response_format"]["json_schema"];
  const result = await createReviewer({ AI: { run: async (_model, payload) => {
    captured = payload.response_format.json_schema;
    expect(payload.temperature).toBe(0); expect(payload.max_tokens).toBe(2048); expect(payload.stream).toBe(false);
    return { response: { summary: "Evidence checked", perCandidate: input.candidates.map(c =>
      ({ agent: c.agent, verdict: "concerns", notes: "Human review required" })), model: REVIEW_MODEL } };
  } } }, { timeoutMs: 90000, maxAttempts: 1 })(input);
  expect(result.model).toBe(REVIEW_MODEL);
  expectBoundSchema(captured, input);
  return captured;
}

it("binds the provider schema to exact model, candidate IDs/count, and passing picks", async () => {
  const schema = await captureSchema(conflictInput);
  const validate = new Ajv().compile(schema);
  expect(validate(good)).toBe(true);
  expect(validate({ ...good, perCandidate: [...good.perCandidate].reverse() })).toBe(true);
  const { recommendation: _recommendation, ...noRecommendation } = good;
  expect(validate(noRecommendation)).toBe(true);
  for (const invalid of [
    { ...good, model: "fallback" }, { ...good, model: "another-model" },
    { ...good, perCandidate: [] }, { ...good, perCandidate: [good.perCandidate[0]] },
    { ...good, perCandidate: [...good.perCandidate, good.perCandidate[0]] },
    { ...good, perCandidate: [{ ...good.perCandidate[0], agent: "mallory" }, good.perCandidate[1]] },
    { ...good, recommendation: { pick: "alice", why: "Failed tests" } },
    { ...good, recommendation: { pick: "mallory", why: "Unknown candidate" } },
    { ...good, recommendation: null }, { ...good, extra: "not allowed" },
  ]) expect(validate(invalid)).toBe(false);
  // The stored Review schema still permits genuine local fallback, never provider admission.
  expect(validates({ ...good, model: "fallback" })).toBe(true);
});

for (const status of ["fail", "error", "skipped", "missing"] as const) {
  it(`forbids provider recommendations when all test evidence is ${status}`, async () => {
    const input: ReviewInput = { ...conflictInput, candidates: conflictInput.candidates.map(c =>
      ({ ...c, tests: status === "missing" ? undefined : { ...c.tests!, status } })) };
    const schema = await captureSchema(input);
    const validate = new Ajv().compile(schema);
    const { recommendation: _recommendation, ...withoutPick } = good;
    expect(validate(withoutPick)).toBe(true); expect(validate(good)).toBe(false);
    const diagnostics: ReviewDiagnostic[] = [];
    const result = await createReviewer({ AI: { run: async () => ({ response: good }) } },
      { maxAttempts: 1, onDiagnostic: d => diagnostics.push(d) })(input);
    expect(result.model).toBe("fallback"); expect(result.recommendation).toBeUndefined();
    expect(diagnostics[1].validationFailure).toBe("recommendation_not_passing");
  });
}

it("zero candidates produce a valid empty-array schema with no recommendation", async () => {
  const schema = await captureSchema({ ...conflictInput, candidates: [] });
  const validate = new Ajv().compile(schema);
  const empty = { summary: "No candidates", perCandidate: [], model: REVIEW_MODEL };
  expect(validate(empty)).toBe(true);
  expect(validate({ ...empty, perCandidate: [good.perCandidate[0]] })).toBe(false);
  expect(validate({ ...empty, recommendation: good.recommendation })).toBe(false);
});

it("sixteen candidates bind all IDs and every passing pick without mutating another request", async () => {
  const input: ReviewInput = { ...conflictInput, candidates: Array.from({ length: 16 }, (_, i) =>
    ({ ...conflictInput.candidates[i % 2], agent: `candidate-${i}` })) };
  const first = await captureSchema(conflictInput);
  const before = JSON.stringify(first);
  const second = await captureSchema(input);
  expect(JSON.stringify(first)).toBe(before);
  expect(second.properties.perCandidate.items.properties.agent.enum).toHaveLength(16);
  expect(second.properties.recommendation?.properties.pick.enum).toHaveLength(8);
  expect(new Ajv().compile(second)({ summary: "Checked all", perCandidate: input.candidates.map(c =>
    ({ agent: c.agent, verdict: "concerns", notes: "Checked" })), model: REVIEW_MODEL })).toBe(true);
  expect(REVIEW_SCHEMA.properties.model.enum).toEqual([REVIEW_MODEL, "fallback"]);
  expect(REVIEW_SCHEMA.properties.perCandidate.maxItems).toBe(16);
  expect(REVIEW_SCHEMA.properties.perCandidate.items.properties.agent).not.toHaveProperty("enum");
});

it("retains exact-once local admission even if a provider ignores schema guidance", async () => {
  expect(isReview({ ...good, perCandidate: [...good.perCandidate].reverse() }, ["alice", "bob"])).toBe(true);
  const invalid = { ...good, perCandidate: [good.perCandidate[0], { ...good.perCandidate[0], notes: "Different text" }] };
  expect(isReview(invalid, ["alice", "bob"])).toBe(false);
  let calls = 0;
  const diagnostics: ReviewDiagnostic[] = [];
  const result = await createReviewer({ AI: { run: async () => { calls++; return { response: invalid }; } } },
    { timeoutMs: 90000, maxAttempts: 1, onDiagnostic: d => diagnostics.push(d) })(conflictInput);
  expect(calls).toBe(1); expect(result.model).toBe("fallback");
  expect(diagnostics[1].validationFailure).toBe("candidate_duplicate");
});

const invalidContracts: Array<[string, unknown, ReviewValidationFailure]> = [
  ["null review", null, "review_object"],
  ["array review", [], "review_object"],
  ["unknown root field", { ...good, privateSentinelKey: "private sentinel" }, "review_fields"],
  ["missing root field", { ...good, model: undefined, summary: undefined }, "summary"],
  ["blank summary", { ...good, summary: " " }, "summary"],
  ["oversized summary", { ...good, summary: "x".repeat(4001) }, "summary"],
  ["provider fallback", { ...good, model: "fallback" }, "model"],
  ["spoofed model", { ...good, model: "private sentinel" }, "model"],
  ["non-array candidates", { ...good, perCandidate: {} }, "candidate_array"],
  ["empty candidates", { ...good, perCandidate: [] }, "candidate_count"],
  ["missing candidate", { ...good, perCandidate: [good.perCandidate[0]] }, "candidate_count"],
  ["extra candidate", { ...good, perCandidate: [...good.perCandidate, good.perCandidate[0]] }, "candidate_count"],
  ["non-object candidate", { ...good, perCandidate: [null, good.perCandidate[1]] }, "candidate_object"],
  ["unknown candidate field", { ...good, perCandidate: [{ ...good.perCandidate[0], privateSentinelKey: "private sentinel" }, good.perCandidate[1]] }, "candidate_fields"],
  ["missing candidate field", { ...good, perCandidate: [{ agent: "alice", verdict: "concerns" }, good.perCandidate[1]] }, "candidate_fields"],
  ["blank agent", { ...good, perCandidate: [{ ...good.perCandidate[0], agent: " " }, good.perCandidate[1]] }, "candidate_agent"],
  ["oversized agent", { ...good, perCandidate: [{ ...good.perCandidate[0], agent: "x".repeat(129) }, good.perCandidate[1]] }, "candidate_agent"],
  ["unknown verdict", { ...good, perCandidate: [{ ...good.perCandidate[0], verdict: "private sentinel" }, good.perCandidate[1]] }, "candidate_verdict"],
  ["blank notes", { ...good, perCandidate: [{ ...good.perCandidate[0], notes: " " }, good.perCandidate[1]] }, "candidate_notes"],
  ["oversized notes", { ...good, perCandidate: [{ ...good.perCandidate[0], notes: "x".repeat(4001) }, good.perCandidate[1]] }, "candidate_notes"],
  ["duplicate agent", { ...good, perCandidate: [good.perCandidate[0], good.perCandidate[0]] }, "candidate_duplicate"],
  ["unknown agent", { ...good, perCandidate: [{ ...good.perCandidate[0], agent: "private sentinel" }, good.perCandidate[1]] }, "candidate_membership"],
  ["null recommendation", { ...good, recommendation: null }, "recommendation_object"],
  ["unknown recommendation field", { ...good, recommendation: { ...good.recommendation, privateSentinelKey: "private sentinel" } }, "recommendation_fields"],
  ["missing recommendation field", { ...good, recommendation: { pick: "bob" } }, "recommendation_fields"],
  ["unknown pick", { ...good, recommendation: { pick: "private sentinel", why: "private sentinel" } }, "recommendation_pick"],
  ["blank pick", { ...good, recommendation: { pick: " ", why: "private sentinel" } }, "recommendation_pick"],
  ["blank reason", { ...good, recommendation: { pick: "bob", why: " " } }, "recommendation_why"],
  ["oversized reason", { ...good, recommendation: { pick: "bob", why: "x".repeat(4001) } }, "recommendation_why"],
  ["failing pick", { ...good, recommendation: { pick: "alice", why: "private sentinel" } }, "recommendation_not_passing"],
];
for (const [name, value, group] of invalidContracts) {
  it(`diagnoses ${name} with a single fixed enum and no model text`, async () => {
    let calls = 0;
    const diagnostics: ReviewDiagnostic[] = [];
    const result = await createReviewer({ AI: { run: async () => { calls++; return { response: value }; } } },
      { timeoutMs: 90000, maxAttempts: 1, onDiagnostic: d => diagnostics.push(d) })(conflictInput);
    expect(calls).toBe(1); expect(result.model).toBe("fallback"); expect(validates(result)).toBe(true);
    expect(diagnostics.map(d => d.reason)).toEqual(["started", "invalid_review"]);
    expect(diagnostics[0].validationFailure).toBeUndefined();
    expect(diagnostics[1].validationFailure).toBe(group);
    const encoded = JSON.stringify(diagnostics);
    for (const privateText of ["private sentinel", "privateSentinelKey", conflictInput.intent,
      conflictInput.candidates[0].diff, good.summary, good.perCandidate[0].notes]) expect(encoded).not.toContain(privateText);
    expect(encoded.length).toBeLessThan(700);
  });
}

it("enum diagnostics tolerate a throwing rejected-value accessor", async () => {
  let reads = 0;
  const response = { ...good, get summary(): string {
    if (++reads === 1) return " ";
    throw new Error("private sentinel");
  } };
  const diagnostics: ReviewDiagnostic[] = [];
  const result = await createReviewer({ AI: { run: async () => ({ response }) } },
    { maxAttempts: 1, onDiagnostic: d => diagnostics.push(d) })(conflictInput);
  expect(result.model).toBe("fallback");
  expect(diagnostics[1]).toMatchObject({ reason: "invalid_review", validationFailure: "unclassified" });
  expect(JSON.stringify(diagnostics)).not.toContain("private sentinel");
});

it("successful admission omits validation diagnostics", async () => {
  const diagnostics: ReviewDiagnostic[] = [];
  const result = await createReviewer({ AI: { run: async () => ({ response: good }) } },
    { maxAttempts: 1, onDiagnostic: d => diagnostics.push(d) })(conflictInput);
  expect(result).toEqual(good);
  expect(diagnostics.map(d => d.reason)).toEqual(["started", "admitted"]);
  expect(diagnostics.every(d => d.validationFailure === undefined)).toBe(true);
});

function discussionTurn(body: string, kind: ReviewInput["turns"][number]["kind"] = "reviewer", id = "prior-review"): ReviewInput["turns"][number] {
  return { id, task: "fixture", author: kind, kind, body, heddleDiscussion: `native-${id}`,
    signedBy: "fixture-signature", at: "2026-10-11T20:00:00Z" };
}
const interruptedFallback = { summary: "Automated review was interrupted. No replacement model call was made; inspect the evidence before deciding.",
  perCandidate: conflictInput.candidates.map(c => ({ agent: c.agent, verdict: "concerns", notes: "Review outcome unavailable after interruption. Human review required." })),
  model: "fallback" };

it("omits only known machine fallback templates from inference context and preserves native history", async () => {
  const fallback = await review(conflictInput);
  const customFallback = { ...fallback, summary: "A distinct historical explanation worth preserving." };
  const substantiveReview = { ...good, recommendation: undefined };
  const turns = [
    discussionTurn(JSON.stringify(fallback), "reviewer", "unavailable"),
    discussionTurn(JSON.stringify(interruptedFallback), "reviewer", "interrupted"),
    discussionTurn(JSON.stringify({ ...fallback, model: REVIEW_MODEL }), "reviewer", "prior-echo"),
    discussionTurn(JSON.stringify(fallback), "human", "human-quote"),
    discussionTurn(JSON.stringify(fallback), "agent", "agent-quote"),
    discussionTurn(JSON.stringify(customFallback), "reviewer", "different-fallback"),
    discussionTurn(JSON.stringify(substantiveReview), "reviewer", "substantive"),
    discussionTurn("Automated model review unavailable. This is a discussion, not the complete template.", "reviewer", "plain-text"),
    discussionTurn('{"model":"fallback",broken', "reviewer", "malformed"),
  ];
  for (const turn of turns) Object.freeze(turn);
  Object.freeze(turns);
  const input = { ...conflictInput, turns };
  const original = JSON.stringify(input);
  let calls = 0;
  const result = await createReviewer({ AI: { run: async (_model, payload) => {
    calls++;
    const context = JSON.parse(payload.messages[1].content);
    expect(context.turns).toEqual(turns.slice(3).map(t => ({ author: t.author, body: t.body.slice(0, 1000) })));
    expect(context.candidates).toHaveLength(2);
    expect(payload.messages[0].content).toContain("Assess the current diffs and test evidence afresh");
    expect(payload.messages[0].content).toContain("explain the specific evidence limitation");
    expect(payload.messages[0].content).toContain("untrusted evidence");
    expectBoundSchema(payload.response_format.json_schema, input);
    return { response: good };
  } } }, { timeoutMs: 90000, maxAttempts: 1 })(input);
  expect(result).toEqual(good); expect(calls).toBe(1);
  expect(JSON.stringify(input)).toBe(original);
  expect(input.turns).toHaveLength(9);
});

it("applies the eight-turn context bound after removing machine templates", async () => {
  const fallback = await review(conflictInput);
  const substantive = Array.from({ length: 10 }, (_, i) => discussionTurn(`Evidence discussion ${i}`, "human", String(i)));
  const templates = Array.from({ length: 12 }, (_, i) => discussionTurn(JSON.stringify(fallback), "reviewer", `fallback-${i}`));
  await createReviewer({ AI: { run: async (_model, payload) => {
    const context = JSON.parse(payload.messages[1].content);
    expect(context.turns).toEqual(substantive.slice(-8).map(t => ({ author: t.author, body: t.body })));
    return { response: good };
  } } }, { maxAttempts: 1 })({ ...conflictInput, turns: [...substantive, ...templates] });
});

it("retains malformed, oversized, extended and near-template reviewer turns", async () => {
  const fallback = await review(conflictInput);
  const retained = [
    discussionTurn("x".repeat(64001)),
    discussionTurn(JSON.stringify({ ...fallback, extra: "preserve this discussion" })),
    discussionTurn(JSON.stringify({ ...fallback, model: "other-model" })),
    discussionTurn(JSON.stringify({ ...fallback, perCandidate: [{ ...fallback.perCandidate[0], notes: "Substantive evidence concern" }, fallback.perCandidate[1]] })),
    discussionTurn(JSON.stringify({ ...fallback, recommendation: good.recommendation })),
    discussionTurn(JSON.stringify({ ...fallback, summary: `${fallback.summary} Additional evidence discussion.` })),
    discussionTurn(JSON.stringify({ ...fallback, perCandidate: [{ ...fallback.perCandidate[0], notes: "Model review unavailable; recorded tests: unknown. Human review required." }, fallback.perCandidate[1]] })),
  ];
  await createReviewer({ AI: { run: async (_model, payload) => {
    const context = JSON.parse(payload.messages[1].content);
    expect(context.turns).toEqual(retained.map(t => ({ author: t.author, body: t.body.slice(0, 1000) })));
    return { response: good };
  } } }, { maxAttempts: 1 })({ ...conflictInput, turns: retained });
});

for (const format of ["object", "json"] as const) {
  for (const template of ["unavailable", "interrupted"] as const) {
    it(`rejects exact ${template} fallback-body echo in ${format} despite the genuine model label`, async () => {
      const localFallback = await review(conflictInput);
      const previous = template === "unavailable" ? localFallback : interruptedFallback;
      const echoed = { ...previous, model: REVIEW_MODEL, perCandidate: [...previous.perCandidate].reverse() };
      let calls = 0;
      const diagnostics: ReviewDiagnostic[] = [];
      const result = await createReviewer({ AI: { run: async () => {
        calls++; return { response: format === "json" ? JSON.stringify(echoed) : echoed };
      } } }, { timeoutMs: 90000, maxAttempts: 1, onDiagnostic: d => diagnostics.push(d) })(conflictInput);
      expect(calls).toBe(1); expect(result).toEqual(localFallback);
      expect(diagnostics.map(d => d.reason)).toEqual(["started", "invalid_review"]);
      expect(diagnostics[1]).toMatchObject({ validationFailure: "fallback_echo", timeoutMs: 90000, maxAttempts: 1 });
      expect(JSON.stringify(diagnostics)).not.toContain(previous.summary);
      expect(JSON.stringify(diagnostics)).not.toContain(previous.perCandidate[0].notes);
    });
  }
}

it("fallback-echo rejection stays within the existing retry budget", async () => {
  const fallback = await review(conflictInput);
  let calls = 0;
  const diagnostics: ReviewDiagnostic[] = [];
  const result = await createReviewer({ AI: { run: async () => {
    calls++; return { response: calls < 3 ? { ...fallback, model: REVIEW_MODEL } : good };
  } } }, { onDiagnostic: d => diagnostics.push(d) })(conflictInput);
  expect(calls).toBe(3); expect(result).toEqual(good);
  expect(diagnostics.map(d => d.reason)).toEqual(["started", "invalid_review", "started", "invalid_review", "started", "admitted"]);
  expect(diagnostics.filter(d => d.validationFailure === "fallback_echo")).toHaveLength(2);
});

it("admits substantive insufficiency and concerns without requiring a recommendation", async () => {
  const fallback = await review(conflictInput);
  const substantive = { summary: "The diff is truncated before the parser's escape-handling branch, so correctness cannot be established.",
    perCandidate: conflictInput.candidates.map(c => ({ agent: c.agent, verdict: "concerns", notes: "The supplied diff omits the relevant branch; test totals alone do not establish correct escaped-pipe handling." })),
    model: REVIEW_MODEL };
  for (const response of [
    substantive,
    { ...substantive, summary: fallback.summary },
    { ...substantive, perCandidate: [fallback.perCandidate[0], substantive.perCandidate[1]] },
    { ...substantive, perCandidate: fallback.perCandidate },
  ]) {
    const diagnostics: ReviewDiagnostic[] = [];
    const result = await createReviewer({ AI: { run: async () => ({ response }) } },
      { maxAttempts: 1, onDiagnostic: d => diagnostics.push(d) })(conflictInput);
    expect(result).toEqual(response); expect(result.recommendation).toBeUndefined();
    expect(diagnostics.map(d => d.reason)).toEqual(["started", "admitted"]);
    expect(diagnostics[1].validationFailure).toBeUndefined();
  }
});

it("a template-shaped response with a substantive passing recommendation is not an exact echo", async () => {
  const fallback = await review(conflictInput);
  const response = { ...fallback, model: REVIEW_MODEL, recommendation: good.recommendation };
  const result = await createReviewer({ AI: { run: async () => ({ response }) } }, { maxAttempts: 1 })(conflictInput);
  expect(result).toEqual(response);
});
