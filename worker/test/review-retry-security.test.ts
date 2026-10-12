// SPDX-License-Identifier: Apache-2.0
// Independent local-only adversarial retry checks. All identities/data are fixtures.
import { describe, expect, it } from 'vitest';
import { SELF, env as testEnv, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import type { Env } from '../env';
import { createReviewer, REVIEW_MODEL, type ReviewDiagnostic } from '../../reviewer/reviewer';

const env = testEnv as unknown as Env;
async function api(path: string, body?: unknown) {
  return SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer test-operator', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function fixture() {
  const id = `security-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${id}`, task = `${base}/tasks/escape`;
  for (const [path, body] of [['/api/projects', { id, seed: { template: 'demo' } }], [`${base}/tasks`, { slug: 'escape', intent: 'escape test' }], [`${task}/agents`, { id: 'reviewer', kind: 'reviewer', displayName: 'Reviewer' }]] as const) expect((await api(path, body)).status).toBe(200);
  const project = env.PROJECT.getByName(id), heads = ['hs-a', 'hs-b'];
  const fallback = { summary: 'Unavailable', perCandidate: [{ agent: 'a', verdict: 'concerns', notes: 'Unavailable' }, { agent: 'b', verdict: 'concerns', notes: 'Unavailable' }], model: 'fallback' };
  await runInDurableObject(project, async instance => {
    for (const [i, agent] of ['a', 'b'].entries()) instance.store.put('candidates', `escape/${agent}`, { task: 'escape', agent, state: heads[i], sourceSha: String(i + 1).repeat(40), conflicts: [], tests: { status: 'pass', summary: 'pass' } });
    await instance.engine.mutate('discuss', { opId: 'first-review', task: 'escape', author: 'reviewer', body: JSON.stringify(fallback) }, { review: fallback });
    instance.store.storage.sql.exec('DELETE FROM meta WHERE key=?', 'reviewDue:escape');
  });
  const before = await (await api(task)).json() as any;
  return { id, project, task, heads, fallback, before, body: { expectHeads: heads, priorTurn: before.turns[0].id }, engine: env.ENGINE.getByName(id) as unknown as { stats(): Promise<any>; delayNext(command: string, ms: number): Promise<void> } };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('fixture did not reach expected barrier');
}

describe('independent bounded review retry security', () => {
  it('production reviewer adapter forwards per-call timeout, call bound, and safe diagnostics', async () => {
    let calls = 0;
    const diagnostics: ReviewDiagnostic[] = [];
    const bound = createReviewer({ AI: { async run() { calls++; return { response: '{malformed fixture' }; } } });
    const result = await (bound as any)({ intent: 'fixture', base: 'fixture', candidates: [{ agent: 'a', diff: 'fixture' }], turns: [] }, { timeoutMs: 90000, maxAttempts: 1, onDiagnostic: (entry: ReviewDiagnostic) => diagnostics.push(entry) });
    expect(result.model).toBe('fallback');
    expect(calls).toBe(1);
    expect(diagnostics.map(entry => entry.reason)).toEqual(['started', 'malformed_json']);
    expect(diagnostics.every(entry => entry.timeoutMs === 90000 && entry.maxAttempts === 1)).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain('malformed fixture');
  });

  it('consumes the reservation without posting if a push arrives while AI is awaited', async () => {
    const f = await fixture();
    await runInDurableObject(f.project, instance => {
      (instance as any).env.REVIEW = { review: async () => {
        (instance as any).retrySecurityStarted = true;
        // A push can start a second, background review; release every pending call, not just the latest.
        await new Promise<void>(resolve => { const waiting = (instance as any).retrySecurityWaiting ??= []; waiting.push(resolve); (instance as any).retrySecurityRelease = () => waiting.splice(0).forEach((r: () => void) => r()); });
        return { ...f.fallback, model: REVIEW_MODEL };
      } };
    });
    const pending = api(`${f.task}/review/retry`, f.body);
    await until(() => runInDurableObject(f.project, instance => !!(instance as any).retrySecurityStarted));
    expect(await f.project.notePush(`${f.id}--escape--reviewer`, 'refs/heads/main', '3'.repeat(40), 'event')).toBe(true);
    await runInDurableObject(f.project, instance => (instance as any).retrySecurityRelease());
    const response = await pending;
    expect(response.status, await response.clone().text()).toBe(409);
    await runInDurableObject(f.project, instance => {
      expect(instance.store.get('meta', 'reviewRetry:escape').status).toBe('consumed');
      expect(instance.store.all('turns')).toHaveLength(1);
      expect(instance.store.get('meta', 'review:escape')).toEqual(f.fallback);
    });
    await evictDurableObject(f.project);
    const later = await api(`${f.task}/review/retry`, f.body);
    expect([200, 409]).toContain(later.status);
    expect((await f.engine.stats()).calls.filter((call: any) => call.command === 'discuss')).toHaveLength(1);
  });

  it('does not publish a stale retry when a new push races native discuss completion', async () => {
    const f = await fixture();
    await f.engine.delayNext('discuss', 200);
    const socketResponse = await SELF.fetch(`https://heddle.test/api/projects/${f.id}/ws`, { headers: { authorization: 'Bearer test-operator', upgrade: 'websocket' } });
    expect(socketResponse.status).toBe(101);
    const socket = socketResponse.webSocket!; socket.accept();
    const events: any[] = []; socket.addEventListener('message', event => { events.push(JSON.parse(event.data as string)); });
    const pending = api(`${f.task}/review/retry`, f.body);
    await until(async () => (await f.engine.stats()).calls.filter((call: any) => call.command === 'discuss').length === 2);
    expect(await f.project.notePush(`${f.id}--escape--reviewer`, 'refs/heads/main', '4'.repeat(40), 'event')).toBe(true);
    const response = await pending;
    expect(response.status, await response.clone().text()).toBe(409);
    await runInDurableObject(f.project, instance => {
      expect(instance.store.get('meta', 'reviewRetry:escape').status).toBe('consumed');
      expect(instance.store.all('turns')).toHaveLength(2);
      expect(instance.store.get('meta', 'review:escape')).toEqual(f.fallback);
      expect(instance.store.rows<any>("SELECT status FROM ops WHERE id LIKE 'review-retry:%'")).toEqual([{ status: 'done' }]);
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(events.some(event => event.type === 'review.posted')).toBe(false);
    expect(events.some(event => event.type === 'discussion.posted')).toBe(true);
    socket.close();
  });

  it('replays a pending native turn after eviction without promoting a review for old heads', async () => {
    const f = await fixture();
    const review = { ...f.fallback, model: REVIEW_MODEL };
    await runInDurableObject(f.project, instance => {
      instance.store.put('meta', 'reviewRetry:escape', { priorTurn: f.body.priorTurn, heads: f.heads, status: 'reserved' });
      instance.store.put('candidates', 'escape/a', { ...instance.store.get<any>('candidates', 'escape/a'), state: 'new-head' });
      instance.store.storage.sql.exec("INSERT INTO ops (id,command,input,context,status) VALUES (?,?,?,?, 'pending')", 'review-retry:escape:interrupted:1', 'discuss', JSON.stringify({ opId: 'review-retry:escape:interrupted:1', task: 'escape', author: 'reviewer', body: JSON.stringify(review) }), JSON.stringify({ review, reviewHeads: f.heads }));
    });
    await evictDurableObject(f.project);
    expect((await api(f.task)).status).toBe(200);
    await until(() => runInDurableObject(f.project, instance => instance.store.rows<any>("SELECT status FROM ops WHERE id='review-retry:escape:interrupted:1'")[0].status === 'done'));
    await runInDurableObject(f.project, instance => {
      expect(instance.store.all('turns')).toHaveLength(2);
      expect(instance.store.get('meta', 'review:escape')).toEqual(f.fallback);
      expect(instance.store.get('meta', 'reviewRetry:escape').status).toBe('reserved');
    });
    expect((await api(`${f.task}/review/retry`, { ...f.body, expectHeads: ['new-head', 'hs-b'] })).status).toBe(409);
    expect((await f.engine.stats()).calls.filter((call: any) => call.command === 'discuss')).toHaveLength(2);
  });
});
