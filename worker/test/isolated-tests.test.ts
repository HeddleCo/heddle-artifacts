// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { SELF, env as testEnv, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../env';
import { FakeTestRunner } from '../../dev/fake-test-runner';
import { memoryArtifacts } from '../../dev/memory-artifacts';
const env = testEnv as unknown as Env;
const sha = (n: number) => n.toString(16).padStart(40, '0');
const api = (path: string, body?: any) => SELF.fetch(`https://heddle.test${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer test-operator', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function fixture(tests?: object) {
  const p = `isolated-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${p}`, task = `${base}/tasks/parser`;
  expect((await api('/api/projects', { id: p, seed: { template: 'demo' }, ...(tests ? { tests } : {}) })).status).toBe(200);
  expect((await api(`${base}/tasks`, { slug: 'parser', intent: 'Improve parser' })).status).toBe(200);
  const join = await (await api(`${task}/agents`, { id: 'alice', kind: 'agent', displayName: 'Alice' })).json() as any;
  const project = env.PROJECT.getByName(p), engine = env.ENGINE.getByName(p) as any;
  await engine.isolateUnreviewed();
  const fake = new FakeTestRunner();
  await runInDurableObject(project, instance => { (instance as any).env.TEST_RUNNER = fake; });
  return { p, base, task, join, project, engine, fake, fork: `${p}--parser--alice` };
}
async function waitFor(task: string, predicate: (view: any) => boolean) {
  for (let i = 0; i < 200; i++) {
    const view = await (await api(task)).json() as any;
    if (predicate(view)) return view;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('candidate observation did not arrive');
}
it('isolated request contains only one scoped read credential; recorded tests flow to board and credential cleanup', async () => {
  const f = await fixture();
  await f.project.notePush(f.fork, 'refs/heads/main', sha(1), 'event');
  const view = await waitFor(f.task, v => v.candidates[0]?.tests?.status === 'pass');
  expect(view.candidates[0].tests).toMatchObject({ provenance: 'isolated sandbox', sourceSha: sha(1), passed: 14 });
  const input = f.fake.inputs[0].input;
  expect(Object.keys(input).sort()).toEqual(['agent', 'project', 'readCredential', 'remote', 'sourceSha', 'task', 'treeSha']);
  expect(input.remote).toBe(f.join.fork.remote); expect(input.sourceSha).toBe(sha(1));
  expect(input.readCredential).toBeTruthy(); expect(JSON.stringify(input)).not.toContain('test-operator');
  expect(JSON.stringify(input)).not.toContain(f.join.agentKey); expect(JSON.stringify(input)).not.toContain(f.join.fork.token);
  expect(f.fake.inputs[0].id).toMatch(/^candidate-test-[a-f0-9]{64}$/);
  expect(f.fake.destroyed).toEqual([f.fake.inputs[0].id]);
  await runInDurableObject(f.project, instance => {
    const leases = instance.credentials.records().filter(r => r.type === 'sandbox-read');
    expect(leases).toHaveLength(1); expect(leases[0]).toMatchObject({ repo: f.fork, owner: 'alice', status: 'revoked' });
    const granted = memoryArtifacts.repos.get(f.fork)!.issued.find(t => t.id === leases[0].id)!;
    expect(granted.scope).toBe('read'); expect(granted.ttl).toBeLessThanOrEqual(240);
    expect(Date.parse(leases[0].expiresAt!) - Date.parse(leases[0].createdAt)).toBeLessThanOrEqual(241000);
    expect(JSON.stringify(instance.store.all('meta'))).not.toContain(input.readCredential);
  });
  const board = await (await api(f.base)).json() as any;
  expect(board.tasks[0].candidates[0].tests.provenance).toBe('isolated sandbox');
});
it('pending isolated tests keep board responsive and block decision and automatic review', async () => {
  const f = await fixture(); f.fake.delayMs = 1000;
  await f.project.notePush(f.fork, 'refs/heads/main', sha(1), 'event');
  const view = await waitFor(f.task, v => v.candidates[0]?.tests?.status === 'pending');
  expect((await api(f.base)).status).toBe(200);
  const response = await api(`${f.task}/decision`, { pick: 'alice', decider: 'human', rationale: 'Select', expectHeads: view.heads });
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'tests_pending' });
  await runInDurableObject(f.project, async instance => {
    instance.store.put('meta', 'reviewDue:parser', Date.now() - 1);
    await (instance as any).reviews();
    expect(instance.store.get('meta', 'lastReviewAttempt:parser')).toBeUndefined();
  });
  await waitFor(f.task, v => v.candidates[0]?.tests?.status === 'pass');
});
for (const failure of ['timeout', 'sandbox', 'install', 'reject'] as const) it(`isolated ${failure} records error rather than pass`, async () => {
  const f = await fixture();
  if (failure === 'install') f.fake.installExitCode = 1;
  else if (failure === 'reject') f.fake.reject = true;
  else f.fake.failure = failure;
  await f.project.notePush(f.fork, 'refs/heads/main', sha(1), 'event');
  const view = await waitFor(f.task, v => v.candidates[0]?.tests?.status === 'error');
  expect(view.candidates[0].tests.passed).toBe(0); expect(f.fake.destroyed).toHaveLength(1);
});
it('a superseded sandbox run never applies to a newer candidate, including the same tree', async () => {
  const f = await fixture(); f.fake.delayMs = 500;
  await f.project.notePush(f.fork, 'refs/heads/main', sha(1), 'event');
  await waitFor(f.task, v => v.candidates[0]?.tests?.status === 'pending');
  await f.project.notePush(f.fork, 'refs/heads/main', sha(2), 'event');
  const view = await waitFor(f.task, v => v.candidates[0]?.sourceSha === sha(2) && v.candidates[0]?.tests?.status === 'pass');
  expect(view.candidates[0].tests.sourceSha).toBe(sha(2));
  await runInDurableObject(f.project, instance => {
    const recorded = instance.store.rows<any>("SELECT input,result FROM ops WHERE command='tests.record'");
    expect(recorded).toHaveLength(2);
    expect(JSON.parse(recorded.find(r => JSON.parse(r.input).sourceSha === sha(1)).result).ignored).toBe(true);
  });
  expect(new Set(f.fake.inputs.map(i => i.id)).size).toBe(2); expect(f.fake.destroyed).toHaveLength(2);
});
it('a project test recipe reaches the sandbox, and its budget decides when a run is too slow', async () => {
  const recipe = { setup: [['npx', '--yes', 'pnpm@10', 'install', '--frozen-lockfile', '--ignore-scripts']], test: ['npx', '--yes', 'pnpm@10', 'test'], budgetSeconds: 420 };
  const f = await fixture(recipe); f.fake.durationMs = 200000;
  await f.project.notePush(f.fork, 'refs/heads/main', sha(31), 'event');
  const view = await waitFor(f.task, v => v.candidates[0]?.tests && v.candidates[0].tests.status !== 'pending');
  expect(view.candidates[0].tests).toMatchObject({ status: 'pass', passed: 14 });
  expect(f.fake.inputs[0].input.recipe).toEqual({ setup: recipe.setup, test: recipe.test, budgetMs: 420000 });
  // The same 200-second run under the default recipe exceeds its 180 seconds.
  const g = await fixture(); g.fake.durationMs = 200000;
  await g.project.notePush(g.fork, 'refs/heads/main', sha(32), 'event');
  const slow = await waitFor(g.task, v => v.candidates[0]?.tests && v.candidates[0].tests.status !== 'pending');
  expect(slow.candidates[0].tests).toMatchObject({ status: 'error', summary: 'Isolated sandbox exceeded 180 seconds' });
  expect(g.fake.inputs[0].input.recipe).toBeUndefined();
});
it('the test recipe is set once, at creation, by the operator', async () => {
  const p = `recipe-${crypto.randomUUID().slice(0, 8)}`, recipe = { test: ['npm', 'test'], budgetSeconds: 300 };
  const bad = await api('/api/projects', { id: p, seed: { template: 'demo' }, tests: { test: ['sh', '-c', 'npm test'] } });
  expect(bad.status).toBe(400); expect(await bad.json()).toMatchObject({ error: 'invalid_test_recipe' });
  expect((await api('/api/projects', { id: p, seed: { template: 'demo' }, tests: recipe })).status).toBe(200);
  // Re-creating without a recipe keeps it; a different recipe is refused.
  expect((await api('/api/projects', { id: p, seed: { template: 'demo' } })).status).toBe(200);
  expect((await api('/api/projects', { id: p, seed: { template: 'demo' }, tests: { ...recipe, budgetSeconds: 600 } })).status).toBe(409);
  const board = await (await api(`/api/projects/${p}`)).json() as any;
  expect(board.project.tests).toEqual({ setup: [], test: ['npm', 'test'], budgetMs: 300000 });
});
