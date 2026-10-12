// SPDX-License-Identifier: Apache-2.0
// Independent, local-only lifecycle checks; all AI/native provider data is fixture data.
import { describe, expect, it } from 'vitest';
import { SELF, env as testEnv, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import type { Env } from '../env';
import { digest } from '../auth';
import { REVIEW_MODEL } from '../../reviewer/reviewer';

const env = testEnv as unknown as Env;
const reviewed = { summary: 'Fixture validated review', perCandidate: [{ agent: 'a', verdict: 'concerns', notes: 'Fixture only' }, { agent: 'b', verdict: 'concerns', notes: 'Fixture only' }], model: REVIEW_MODEL };
async function api(path: string, body?: unknown, token = 'test-operator') {
  const response = await SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
}
async function fixture(active = false) {
  const id = `auto-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${id}`, task = `${base}/tasks/escape`;
  for (const [path, body] of [['/api/projects', { id, seed: { template: 'demo' } }], [`${base}/tasks`, { slug: 'escape', intent: 'escape test' }], [`${task}/agents`, { id: 'reviewer', kind: 'reviewer', displayName: 'Reviewer' }]] as const) {
    const response = await api(path, body); expect(response.status, await response.text()).toBe(200);
  }
  const project = env.PROJECT.getByName(id), heads = ['hs-a', 'hs-b'], headKey = await digest(heads.join(':'));
  await runInDurableObject(project, async instance => {
    for (const [i, agent] of ['a', 'b'].entries()) instance.store.put('candidates', `escape/${agent}`, { task: 'escape', agent, state: heads[i], sourceSha: String(i + 1).repeat(40), conflicts: [], tests: { status: 'pass', summary: 'pass' } });
    instance.store.put('meta', 'reviewDue:escape', 1);
    if (!active) {
      const lane = instance.store.get<any>('lanes', 'escape/reviewer');
      instance.store.put('lanes', 'escape/reviewer', { ...lane, status: 'released' });
    }
    await instance.store.storage.deleteAlarm();
  });
  return { id, project, task, heads, headKey, key: `reviewAttempt:escape:${headKey}`, opId: `review:${headKey}`, engine: env.ENGINE.getByName(id) as unknown as { stats(): Promise<any>; delayNext(command: string, ms: number): Promise<void>; failNext(command: string, count?: number, after?: boolean): Promise<void> } };
}
async function installReviewer(project: ReturnType<Env['PROJECT']['getByName']>, paused = false) {
  await runInDurableObject(project, instance => {
    (instance as any).env.REVIEW = { review: async (_input: unknown, options: any) => {
      instance.store.put('meta', 'fixtureCalls', (instance.store.get<number>('meta', 'fixtureCalls') ?? 0) + 1);
      expect(options.timeoutMs).toBe(90000); expect(options.maxAttempts).toBe(1);
      options.onDiagnostic({ model: REVIEW_MODEL, reason: 'started', attempt: 1, elapsedMs: 0, timeoutMs: 90000, maxAttempts: 1 });
      if (paused) await new Promise<void>(resolve => { (instance as any).fixtureRelease = resolve; });
      options.onDiagnostic({ model: REVIEW_MODEL, reason: 'admitted', attempt: 1, elapsedMs: 1, timeoutMs: 90000, maxAttempts: 1, responseType: 'object' });
      return reviewed;
    } };
  });
}
async function runReviews(project: ReturnType<Env['PROJECT']['getByName']>) {
  await runInDurableObject(project, instance => instance.engine.serial(() => (instance as any).reviews()));
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('fixture did not reach expected barrier');
}

describe('independent automatic review security', () => {
  it('uses 90 seconds/one inference and retains the prepared review across native failure and restart', async () => {
    const f = await fixture(); await installReviewer(f.project);
    await f.engine.failNext('discuss', 1, true);
    await runReviews(f.project);
    await runInDurableObject(f.project, instance => {
      expect(instance.store.get('meta', 'fixtureCalls')).toBe(1);
      expect(instance.store.get('meta', f.key)).toMatchObject({ status: 'completed', review: reviewed });
      expect(instance.store.all('turns')).toHaveLength(1);
      instance.store.put('meta', 'reviewDue:escape', 1);
    });
    const calls = (await f.engine.stats()).calls.filter((call: any) => call.command === 'discuss');
    expect(calls).toHaveLength(2); expect(calls[0].input.opId).toBe(calls[1].input.opId);
    await evictDurableObject(f.project); await installReviewer(f.project); await runReviews(f.project);
    const snapshot = await (await api(f.task)).json() as any;
    expect(snapshot.reviewAttempt.diagnostics.map((diagnostic: any) => diagnostic.reason)).toEqual(['started', 'admitted']);
    expect(snapshot.review).toEqual(reviewed); expect(snapshot.turns).toHaveLength(1);
    expect((await api(f.task, undefined, 'invalid-fixture')).status).toBe(403);
    await runInDurableObject(f.project, instance => { expect(instance.store.get('meta', 'fixtureCalls')).toBe(1); });
    expect((await f.engine.stats()).calls.filter((call: any) => call.command === 'discuss')).toHaveLength(2);
  });

  it('uses an honest fallback after an interrupted reservation without another inference', async () => {
    const f = await fixture();
    await runInDurableObject(f.project, instance => {
      instance.store.put('meta', f.key, { status: 'reserved', heads: f.heads, diagnostics: [], createdAt: new Date().toISOString() });
      instance.store.put('meta', 'lastReviewAttempt:escape', f.key);
    });
    await evictDurableObject(f.project); await installReviewer(f.project); await runReviews(f.project);
    const snapshot = await (await api(f.task)).json() as any;
    expect(snapshot.review.model).toBe('fallback'); expect(snapshot.review.summary).toContain('interrupted');
    expect(snapshot.reviewAttempt.status).toBe('completed'); expect(snapshot.turns).toHaveLength(1);
    await runInDurableObject(f.project, instance => { expect(instance.store.get('meta', 'fixtureCalls')).toBeUndefined(); });
  });

  it('publishes a prepared result after eviction without another inference', async () => {
    const f = await fixture();
    await runInDurableObject(f.project, instance => {
      instance.store.put('meta', f.key, { status: 'prepared', heads: f.heads, diagnostics: [], review: reviewed, createdAt: new Date().toISOString() });
      instance.store.put('meta', 'lastReviewAttempt:escape', f.key);
    });
    await evictDurableObject(f.project); await installReviewer(f.project); await runReviews(f.project);
    const snapshot = await (await api(f.task)).json() as any;
    expect(snapshot.review).toEqual(reviewed); expect(snapshot.reviewAttempt.status).toBe('completed'); expect(snapshot.turns).toHaveLength(1);
    await runInDurableObject(f.project, instance => { expect(instance.store.get('meta', 'fixtureCalls')).toBeUndefined(); });
  });

  it('replays a journaled native review after eviction without reinference or a duplicate turn', async () => {
    const f = await fixture();
    await runInDurableObject(f.project, instance => {
      instance.store.put('meta', f.key, { status: 'prepared', heads: f.heads, diagnostics: [], review: reviewed });
      instance.store.put('meta', 'lastReviewAttempt:escape', f.key);
      const input = { opId: f.opId, task: 'escape', author: 'reviewer', body: JSON.stringify(reviewed) };
      instance.store.storage.sql.exec("INSERT INTO ops (id,command,input,context,status) VALUES (?,?,?,?, 'pending')", f.opId, 'discuss', JSON.stringify(input), JSON.stringify({ review: reviewed, reviewHeads: f.heads }));
    });
    await evictDurableObject(f.project); await installReviewer(f.project);
    await runInDurableObject(f.project, async instance => { await instance.alarm(); });
    await runInDurableObject(f.project, instance => {
      expect(instance.store.get('meta', 'fixtureCalls')).toBeUndefined();
      expect(instance.store.get('meta', 'review:escape')).toEqual(reviewed); expect(instance.store.all('turns')).toHaveLength(1);
      expect(instance.store.get('meta', f.key).status).toBe('completed');
      expect(instance.store.rows<any>('SELECT status FROM ops WHERE id=?', f.opId)).toEqual([{ status: 'done' }]);
    });
    expect((await f.engine.stats()).calls.filter((call: any) => call.command === 'discuss')).toHaveLength(1);
  });

  for (const interruption of ['cleanup', 'push'] as const) {
    it(`does not start inference when ${interruption} arrives during reservation sync`, async () => {
      const f = await fixture(true); await installReviewer(f.project);
      await runInDurableObject(f.project, instance => {
        const storage = instance.store.storage, sync = storage.sync.bind(storage);
        storage.sync = async () => {
          await sync();
          if (instance.store.get('meta', f.key)?.status !== 'reserved') return;
          storage.sync = sync;
          if (interruption === 'cleanup') instance.credentials.close();
          else expect(await instance.notePush(`${f.id}--escape--reviewer`, 'refs/heads/main', '5'.repeat(40), 'event')).toBe(true);
        };
      });
      await runReviews(f.project);
      await runInDurableObject(f.project, instance => {
        expect(instance.store.get('meta', 'fixtureCalls')).toBeUndefined();
        expect(instance.store.get('meta', f.key)?.status).toBe('reserved');
        expect(instance.store.get('meta', 'review:escape')).toBeUndefined(); expect(instance.store.all('turns')).toHaveLength(0);
      });
    });
  }

  it('does not publish a review when a push arrives while inference is awaited', async () => {
    const f = await fixture(true); await installReviewer(f.project, true);
    const pending = runReviews(f.project);
    await until(() => runInDurableObject(f.project, instance => !!(instance as any).fixtureRelease));
    expect(await f.project.notePush(`${f.id}--escape--reviewer`, 'refs/heads/main', '3'.repeat(40), 'event')).toBe(true);
    await runInDurableObject(f.project, instance => { (instance as any).fixtureRelease(); });
    await pending;
    await runInDurableObject(f.project, instance => {
      expect(instance.store.get('meta', 'fixtureCalls')).toBe(1);
      expect(instance.store.get('meta', 'review:escape')).toBeUndefined(); expect(instance.store.all('turns')).toHaveLength(0);
    });
  });

  it('does not abandon a prepared review because an unrelated task receives a push', async () => {
    const f = await fixture();
    const other = `/api/projects/${f.id}/tasks/other`;
    for (const [path, body] of [[`/api/projects/${f.id}/tasks`, { slug: 'other', intent: 'independent task' }], [`${other}/agents`, { id: 'reviewer', kind: 'reviewer', displayName: 'Reviewer' }]] as const) {
      const response = await api(path, body); expect(response.status, await response.text()).toBe(200);
    }
    await installReviewer(f.project, true);
    const pending = runReviews(f.project);
    await until(() => runInDurableObject(f.project, instance => !!(instance as any).fixtureRelease));
    expect(await f.project.notePush(`${f.id}--other--reviewer`, 'refs/heads/main', '6'.repeat(40), 'event')).toBe(true);
    await runInDurableObject(f.project, instance => { (instance as any).fixtureRelease(); });
    await pending;
    await runInDurableObject(f.project, instance => {
      expect(instance.store.get('meta', 'fixtureCalls')).toBe(1);
      expect(instance.store.get('meta', 'review:escape')).toEqual(reviewed);
      expect(instance.store.get('meta', f.key).status).toBe('completed');
      expect(instance.store.all<any>('turns').filter(turn => turn.task === 'escape')).toHaveLength(1);
    });
  });

  it('retains a late native signed turn only as discussion when a push races completion', async () => {
    const f = await fixture(true); await installReviewer(f.project); await f.engine.delayNext('discuss', 200);
    const pending = runReviews(f.project);
    await until(async () => (await f.engine.stats()).calls.some((call: any) => call.command === 'discuss'));
    expect(await f.project.notePush(`${f.id}--escape--reviewer`, 'refs/heads/main', '4'.repeat(40), 'event')).toBe(true);
    await pending;
    await runInDurableObject(f.project, instance => {
      expect(instance.store.get('meta', 'fixtureCalls')).toBe(1);
      expect(instance.store.get('meta', 'review:escape')).toBeUndefined(); expect(instance.store.all('turns')).toHaveLength(1);
      expect(instance.store.get('meta', f.key).status).toBe('stale');
    });
  });
});
