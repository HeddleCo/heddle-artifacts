// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { SELF, env as testEnv, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../env';
const env = testEnv as unknown as Env;
async function api(path: string, body?: unknown, token: string | null = 'test-operator') {
  return SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function ok(path: string, body?: unknown, token?: string | null) { const r = await api(path, body, token); expect(r.status, await r.clone().text()).toBe(200); return r.json() as Promise<any>; }
it('captures route returns all pushes, excludes reviewers, persists semantic cache and skips repeat snapshots', async () => {
  const p = `captures-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${p}`, task = `${base}/tasks/table`;
  await ok('/api/projects', { id: p, seed: { template: 'demo' } });
  await ok(`${base}/tasks`, { slug: 'table', intent: 'capture history' });
  const join = await ok(`${task}/agents`, { id: 'alice', kind: 'agent', displayName: 'Alice' });
  await ok(`${task}/agents`, { id: 'reviewer', kind: 'reviewer', displayName: 'Reviewer' });
  const project = env.PROJECT.getByName(p), engine = env.ENGINE.getByName(p) as unknown as { stats(): Promise<any>; loseDisk(): Promise<void>; failNext(command: string, count?: number, after?: boolean): Promise<void> };
  await runInDurableObject(project, async instance => {
    await instance.engine.serial(async () => {
      for (const i of [3, 1, 2]) await instance.engine.mutate('ingest', { opId: `push-${i}`, items: [{ task: 'table', agent: 'alice', sha: String(i).repeat(40) }] });
      await instance.engine.mutate('ingest', { opId: 'reviewer-push', items: [{ task: 'table', agent: 'reviewer', sha: '4'.repeat(40) }] });
    });
  });
  expect((await api(`${task}/captures`, undefined, null)).status).toBe(403);
  const first = await ok(`${task}/captures`, undefined, join.agentKey);
  expect(first.lanes.map((l: any) => l.agent)).toEqual(['alice']);
  expect(first.lanes[0].captures.map((c: any) => c.sourceSha)).toEqual([1, 2, 3].map(i => String(i).repeat(40)));
  expect(first.pending).toBe(2); expect(first.cacheChanged).toBeUndefined();
  expect((await ok(`${task}/captures`)).pending).toBe(1);
  const complete = await ok(`${task}/captures`); expect(complete.pending).toBe(0);
  expect(complete.lanes[0].captures[0].semantic.changes[0].description).toBe('Function modified: parseRow in src/table.ts');
  const before = await engine.stats(), snapshotCount = before.calls.filter((c: any) => c.command === 'snapshot').length;
  expect(Object.keys(before.state.semanticDiffs)).toHaveLength(3);
  await ok(`${task}/captures`);
  expect((await engine.stats()).calls.filter((c: any) => c.command === 'snapshot')).toHaveLength(snapshotCount);
  await engine.loseDisk();
  expect(await ok(`${task}/captures`)).toEqual(complete);
  expect(Object.keys((await engine.stats()).state.semanticDiffs)).toHaveLength(3);
  expect((await engine.stats()).calls.filter((c: any) => c.command === 'snapshot')).toHaveLength(snapshotCount);
});
it('captures uses the public demo task read policy and still rejects unknown tasks', async () => {
  const base = '/api/projects/demo';
  await ok('/api/projects', { id: 'demo', seed: { template: 'demo' } });
  await ok(`${base}/tasks`, { slug: 'history', intent: 'public history' });
  expect(await ok(`${base}/tasks/history/captures`, undefined, null)).toEqual({ task: 'history', lanes: [], pending: 0 });
  expect((await api(`${base}/tasks/missing/captures`, undefined, null)).status).toBe(404);
});
