// SPDX-License-Identifier: Apache-2.0
// Independent composition checks: real Worker + real reviewer, fixture AI/native engine only.
import { describe, expect, it } from 'vitest';
import { SELF, env as testEnv, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import type { Env } from '../env';
import { createReviewer, REVIEW_MODEL, type ReviewModelInput } from '../../reviewer/reviewer';

const env = testEnv as unknown as Env;
const unavailable = {
  summary: 'Automated model review unavailable. Inspect the diffs and test evidence before deciding.',
  perCandidate: ['a', 'b'].map(agent => ({ agent, verdict: 'concerns' as const, notes: 'Model review unavailable; recorded tests: pass. Human review required.' })),
  model: REVIEW_MODEL,
};
const interrupted = {
  summary: 'Automated review was interrupted. No replacement model call was made; inspect the evidence before deciding.',
  perCandidate: ['a', 'b'].map(agent => ({ agent, verdict: 'concerns' as const, notes: 'Review outcome unavailable after interruption. Human review required.' })),
  model: REVIEW_MODEL,
};
const abstention = {
  summary: 'The diff is too short to establish how escaped trailing delimiters behave.',
  perCandidate: ['a', 'b'].map(agent => ({ agent, verdict: 'concerns' as const, notes: 'Recorded tests pass, but the supplied diff omits the surrounding parser. More context is needed.' })),
  model: REVIEW_MODEL,
};

async function api(path: string, body?: unknown, token = 'test-operator') {
  const response = await SELF.fetch(`https://heddle.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
}
async function ok(path: string, body?: unknown) {
  const response = await api(path, body), value = await response.json() as any;
  expect(response.status, JSON.stringify(value)).toBe(200); return value;
}
async function fixture() {
  const id = `composed-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${id}`, task = `${base}/tasks/escape`;
  await ok('/api/projects', { id, seed: { template: 'demo' } });
  await ok(`${base}/tasks`, { slug: 'escape', intent: 'Support escaped delimiters without changing the parser API.' });
  for (const agent of ['a', 'b', 'reviewer']) await ok(`${task}/agents`, { id: agent, kind: agent === 'reviewer' ? 'reviewer' : 'agent', displayName: agent });
  await ok(`${base}/humans`, { id: 'human', displayName: 'Fixture human' });
  const project = env.PROJECT.getByName(id);
  await runInDurableObject(project, async instance => {
    await instance.engine.mutate('ingest', { opId: 'fixture-candidates', items: ['a', 'b'].map((agent, i) => ({
      task: 'escape', agent, fork: { remote: instance.store.get<any>('lanes', `escape/${agent}`).forkRemote },
      ref: 'refs/heads/main', sha: String(i + 1).repeat(40),
    })), runTests: true });
    await (instance as any).syncCandidates();
    for (const lane of instance.store.all<any>('lanes')) instance.store.put('lanes', `escape/${lane.agent}`, { ...lane, status: 'released' });
    instance.store.storage.sql.exec('DELETE FROM meta WHERE key=?', 'reviewDue:escape');
    await instance.store.storage.deleteAlarm();
  });
  return { id, base, task, project, engine: env.ENGINE.getByName(id) as unknown as { stats(): Promise<any> } };
}
async function installResponses(project: ReturnType<Env['PROJECT']['getByName']>, responses: unknown[]) {
  await runInDurableObject(project, instance => {
    const requests: ReviewModelInput[] = [];
    (instance as any).composedRequests = requests;
    (instance as any).env.REVIEW = { review: createReviewer({ AI: { async run(_model, input) {
      requests.push(structuredClone(input));
      const next = responses[requests.length - 1];
      if (next instanceof Error) throw next;
      return { response: structuredClone(next) };
    } } }) };
  });
}
async function automatic(project: ReturnType<Env['PROJECT']['getByName']>) {
  await runInDurableObject(project, instance => instance.engine.serial(async () => {
    instance.store.put('meta', 'reviewDue:escape', 1);
    await (instance as any).reviews();
  }));
}

describe('composed Worker and production reviewer admission', () => {
  it.each([['unavailable', unavailable], ['interrupted', interrupted]] as const)('rejects the exact %s template with one inference and preserves its signed fallback on retry', async (_name, echo) => {
    const f = await fixture();
    await installResponses(f.project, [echo, abstention]);
    await automatic(f.project);
    const before = await ok(f.task);
    expect(before.review.model).toBe('fallback');
    expect(before.reviewAttempt.diagnostics.map((d: any) => [d.reason, d.validationFailure])).toEqual([['started', undefined], ['invalid_review', 'fallback_echo']]);
    expect(before.reviewAttempt.diagnostics.every((d: any) => d.maxAttempts === 1 && d.timeoutMs === 90000)).toBe(true);
    expect(before.turns).toHaveLength(1);
    const original = JSON.stringify(before.turns[0]);
    const human = await ok(`${f.task}/turns`, { as: 'human', body: 'Keep the current parser API; inspect trailing delimiters.' });
    const retry = { expectHeads: before.heads, priorTurn: before.turns[0].id };
    const duplicate = await Promise.all([api(`${f.task}/review/retry`, retry), api(`${f.task}/review/retry`, retry)]);
    for (const response of duplicate) expect(response.status, await response.clone().text()).toBe(200);
    const after = await ok(f.task);
    expect(after.review).toEqual(abstention);
    expect(after.turns).toHaveLength(3);
    expect(JSON.stringify(after.turns[0])).toBe(original);
    expect(after.turns[1]).toEqual(human);
    expect(after.turns[2].signedBy).toBe(after.turns[0].signedBy);
    expect(after.turns[2].kind).toBe('reviewer');
    expect(after.decision).toBeUndefined();
    await runInDurableObject(f.project, instance => {
      const requests = (instance as any).composedRequests as ReviewModelInput[];
      expect(requests).toHaveLength(2);
      const context = JSON.parse(requests[1].messages[1].content);
      expect(context.turns).toEqual([{ author: 'human', body: human.body }]);
      expect(requests[1].response_format.json_schema.properties.model.enum).toEqual([REVIEW_MODEL]);
      expect(instance.store.get('meta', 'reviewRetry:escape')).toMatchObject({ status: 'completed', model: REVIEW_MODEL });
      expect(instance.store.all('decisions')).toHaveLength(0);
    });
    await evictDurableObject(f.project);
    expect((await api(`${f.task}/review/retry`, retry)).status).toBe(200);
    expect((await ok(f.task)).turns).toEqual(after.turns);
    const calls = (await f.engine.stats()).calls;
    expect(calls.filter((call: any) => call.command === 'discuss')).toHaveLength(3);
    expect(calls.filter((call: any) => ['decide', 'publish'].includes(call.command))).toHaveLength(0);
  });

  it('a copied template returned by explicit retry stays fallback without another call or an automatic decision', async () => {
    const f = await fixture();
    await installResponses(f.project, [unavailable, interrupted]);
    await automatic(f.project);
    const before = await ok(f.task), retry = { expectHeads: before.heads, priorTurn: before.turns[0].id };
    const result = await ok(`${f.task}/review/retry`, retry);
    expect(result.review.model).toBe('fallback');
    expect(result.retry).toMatchObject({ status: 'completed', model: 'fallback' });
    expect(result.retry.diagnostics.at(-1)).toMatchObject({ reason: 'invalid_review', validationFailure: 'fallback_echo', timeoutMs: 90000, maxAttempts: 1 });
    await ok(`${f.task}/review/retry`, retry);
    const after = await ok(f.task);
    expect(after.turns).toHaveLength(2); expect(after.turns[0]).toEqual(before.turns[0]);
    expect(after.decision).toBeUndefined();
    await runInDurableObject(f.project, instance => expect((instance as any).composedRequests).toHaveLength(2));
  });

  it('preserves legitimate prior abstention in inference context and accepts a fresh concern-only review', async () => {
    const f = await fixture();
    const prior = await ok(`${f.task}/turns`, { as: 'reviewer', body: JSON.stringify(abstention) });
    await installResponses(f.project, [abstention]);
    await automatic(f.project);
    const after = await ok(f.task);
    expect(after.review).toEqual(abstention); expect(after.turns[0]).toEqual(prior);
    expect(after.reviewAttempt.diagnostics.at(-1).reason).toBe('admitted');
    await runInDurableObject(f.project, instance => {
      const requests = (instance as any).composedRequests as ReviewModelInput[];
      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0].messages[1].content).turns).toEqual([{ author: 'reviewer', body: prior.body.slice(0, 1000) }]);
    });
  });

  it.each(['skipped', 'error', 'fail'] as const)('withheld or nonpassing tests (%s) cannot become a model recommendation', async status => {
    const f = await fixture();
    await runInDurableObject(f.project, instance => {
      for (const candidate of instance.store.all<any>('candidates')) instance.store.put('candidates', `escape/${candidate.agent}`, {
        ...candidate, tests: { ...candidate.tests, status, summary: 'Tests withheld: synthetic fixture is not trusted.' },
      });
    });
    await installResponses(f.project, [{ ...abstention, recommendation: { pick: 'a', why: 'The provider incorrectly recommends a candidate with no passing test evidence.' } }]);
    await automatic(f.project);
    const after = await ok(f.task);
    expect(after.review.model).toBe('fallback'); expect(after.review.recommendation).toBeUndefined();
    expect(after.reviewAttempt.diagnostics.at(-1)).toMatchObject({ reason: 'invalid_review', validationFailure: 'recommendation_not_passing' });
    expect(after.decision).toBeUndefined();
    await runInDurableObject(f.project, instance => {
      const requests = (instance as any).composedRequests as ReviewModelInput[];
      expect(requests).toHaveLength(1);
      expect(requests[0].response_format.json_schema.properties).not.toHaveProperty('recommendation');
    });
    expect((await f.engine.stats()).calls.filter((call: any) => ['decide', 'publish'].includes(call.command))).toHaveLength(0);
  });

  it('provider rejection makes one fallback review and duplicate operator decisions publish exactly once', async () => {
    const f = await fixture();
    await installResponses(f.project, [new Error('synthetic provider rejection, private detail must not leak')]);
    await automatic(f.project);
    const reviewed = await ok(f.task);
    expect(reviewed.review.model).toBe('fallback');
    expect(reviewed.reviewAttempt.diagnostics.at(-1).reason).toBe('provider_error');
    expect(JSON.stringify(reviewed)).not.toContain('private detail');
    const body = { expectHeads: reviewed.heads, decider: 'human', pick: 'a', rationale: 'The fixture human explicitly selects this candidate.' };
    const responses = await Promise.all([api(`${f.task}/decision`, body), api(`${f.task}/decision`, body)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const after = await ok(f.task);
    expect(after.task.status).toBe('decided'); expect(after.decision.mainSha).toMatch(/^[a-f0-9]{40}$/);
    expect(after.turns).toEqual(reviewed.turns);
    const calls = (await f.engine.stats()).calls;
    expect(calls.filter((call: any) => call.command === 'decide')).toHaveLength(1);
    expect(calls.filter((call: any) => call.command === 'publish')).toHaveLength(1);
    await runInDurableObject(f.project, instance => expect((instance as any).composedRequests).toHaveLength(1));
  });

  it('the configured one-call 90-second deadline produces fallback and ignores late provider success', async () => {
    const f = await fixture();
    await runInDurableObject(f.project, instance => {
      (instance as any).composedDeadlineCalls = 0;
      (instance as any).env.REVIEW = { review: createReviewer({ AI: { run() {
        (instance as any).composedDeadlineCalls++;
        return new Promise(resolve => { (instance as any).composedLateResult = resolve; });
      } } }) };
    });
    // Accelerate only the real reviewer's exact 90-second timer; all coordination
    // timers retain their normal behavior. No provider call or wall-clock wait.
    const originalTimer = globalThis.setTimeout;
    const reviewTimers: number[] = [];
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay === 90000) reviewTimers.push(delay);
      return originalTimer(callback, delay === 90000 ? 1 : delay, ...args);
    }) as typeof setTimeout;
    try { await automatic(f.project); }
    finally { globalThis.setTimeout = originalTimer; }
    expect(reviewTimers).toEqual([90000]);
    const before = await ok(f.task);
    expect(before.review.model).toBe('fallback');
    expect(before.reviewAttempt.diagnostics.map((d: any) => d.reason)).toEqual(['started', 'deadline']);
    await runInDurableObject(f.project, async instance => {
      expect((instance as any).composedDeadlineCalls).toBe(1);
      (instance as any).composedLateResult({ response: abstention });
      await Promise.resolve();
      await Promise.resolve();
    });
    const after = await ok(f.task);
    expect(after.review).toEqual(before.review);
    expect(after.turns).toEqual(before.turns);
    expect(after.decision).toBeUndefined();
    expect((await f.engine.stats()).calls.filter((call: any) => call.command === 'discuss')).toHaveLength(1);
  });
});
