// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { SELF, env as testEnv, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../env';
import { REVIEW_WAIT_MS } from '../project-do';
const env = testEnv as unknown as Env;
async function ok(path: string, body?: unknown) {
  const r = await SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer test-operator', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(r.status, await r.clone().text()).toBe(200); return r.json() as Promise<any>;
}
it('review waits for every active agent lane, or REVIEW_WAIT_MS after the first candidate', async () => {
  const p = `timing-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${p}`;
  await ok('/api/projects', { id: p, seed: { template: 'demo' } });
  await ok(`${base}/tasks`, { slug: 'escape', intent: 'escape test' });
  for (const id of ['a', 'b']) await ok(`${base}/tasks/escape/agents`, { id, kind: 'agent', displayName: id });
  await ok(`${base}/tasks/escape/agents`, { id: 'reviewer', kind: 'reviewer', displayName: 'Reviewer' });
  // ProjectDO's full RPC type makes runInDurableObject's generic too deep for tsc (TS2589); inspect untyped.
  const inspect = runInDurableObject as unknown as (stub: unknown, fn: (instance: any) => Promise<void>) => Promise<void>;
  await inspect(env.PROJECT.getByName(p), async (instance: any) => {
    const now = new Date().toISOString(), old = new Date(Date.now() - REVIEW_WAIT_MS - 1000).toISOString();
    const candidate = (agent: string, capturedAt = now) => ({ task: 'escape', agent, capturedAt, conflicts: [], tests: { status: 'pass' } });
    // The reviewer's own lane never counts as a lane awaiting a candidate.
    expect(instance.awaitingLanes('escape', [candidate('a')])).toBe(true);
    expect(instance.awaitingLanes('escape', [candidate('a'), candidate('b')])).toBe(false);
    expect(instance.awaitingLanes('escape', [candidate('a', old)])).toBe(false);
    const lane = instance.store.get('lanes', 'escape/b'); instance.store.put('lanes', 'escape/b', { ...lane, status: 'abandoned' });
    expect(instance.awaitingLanes('escape', [candidate('a')])).toBe(false);
  });
});
