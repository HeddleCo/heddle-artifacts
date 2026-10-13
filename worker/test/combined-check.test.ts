// SPDX-License-Identifier: Apache-2.0
// The combined check's control-plane state machine, against the stub engine and the fake sandbox:
// main advances → the stale task's candidates are merged with it → the merged commit is tested in an
// isolated sandbox fetched from the canonical repo → landing waits for, and obeys, that result.
import { it, expect } from 'vitest';
import { SELF, env as testEnv, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../env';
import { FakeTestRunner } from '../../dev/fake-test-runner';
import { memoryArtifacts } from '../../dev/memory-artifacts';
const env = testEnv as unknown as Env;
const sha = (n: number) => n.toString(16).padStart(40, '0');
const api = (path: string, body?: any) => SELF.fetch(`https://heddle.test${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer test-operator', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const VITEST_FAIL = [
  ' ❯ test/read-table.test.ts (3 tests | 3 failed) 6ms',
  '   × readTable > returns the header 3ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  test/read-table.test.ts > readTable > returns the header',
  "AssertionError: expected [ ' Name ', ' Age ' ] to deeply equal [ 'Name', 'Age' ]",
  ' FAIL  test/read-table.test.ts > readTable > returns the body rows',
  ' FAIL  test/read-table.test.ts > readTable > handles a header-only table',
  '',
  ' Test Files  1 failed | 2 passed (3)',
  '      Tests  3 failed | 19 passed (22)',
].join('\n');
async function fixture() {
  const p = `combined-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${p}`;
  const created = await (await api('/api/projects', { id: p, seed: { template: 'demo' } })).json() as any;
  for (const [slug, intent] of [['whitespace', 'Preserve whitespace inside cells'], ['shape', 'Return the header separately']]) expect((await api(`${base}/tasks`, { slug, intent })).status).toBe(200);
  expect((await api(`${base}/humans`, { id: 'luke', displayName: 'Luke' })).status).toBe(200);
  for (const [task, id] of [['whitespace', 'erin'], ['shape', 'finn']]) expect((await api(`${base}/tasks/${task}/agents`, { id, kind: 'agent', displayName: id })).status).toBe(200);
  const project = env.PROJECT.getByName(p), engine = env.ENGINE.getByName(p) as any;
  await engine.isolateUnreviewed();
  const fake = new FakeTestRunner(); fake.output = '      Tests  22 passed (22)\n';
  await runInDurableObject(project, instance => { (instance as any).env.TEST_RUNNER = fake; });
  return { p, base, project, engine, fake, canonical: created.canonicalRemote as string };
}
async function waitFor(path: string, predicate: (view: any) => boolean) {
  for (let i = 0; i < 300; i++) {
    const view = await (await api(path)).json() as any;
    if (predicate(view)) return view;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`state did not arrive: ${JSON.stringify((await (await api(path)).json() as any).candidates?.map((c: any) => [c.agent, c.tests?.status, c.combined]))}`);
}
async function landWhitespace(f: Awaited<ReturnType<typeof fixture>>, beforeDecide = () => {}) {
  await f.project.notePush(`${f.p}--whitespace--erin`, 'refs/heads/main', sha(1), 'event');
  await f.project.notePush(`${f.p}--shape--finn`, 'refs/heads/main', sha(2), 'event');
  await waitFor(`${f.base}/tasks/whitespace`, v => v.candidates[0]?.tests?.status === 'pass');
  const shape = await waitFor(`${f.base}/tasks/shape`, v => v.candidates[0]?.tests?.status === 'pass');
  expect(shape.candidates[0].combined).toBeUndefined();
  const whitespace = await (await api(`${f.base}/tasks/whitespace`)).json() as any;
  // The decision request itself triggers the combined check, so the sandbox's behaviour is set first.
  beforeDecide();
  const decision = await (await api(`${f.base}/tasks/whitespace/decision`, { pick: 'erin', decider: 'luke', rationale: 'Code tables need indentation', expectHeads: whitespace.heads })).json() as any;
  expect(decision.mainSha).toMatch(/^[a-f0-9]{40}$/);
  return decision;
}
it('after main advances, a stale candidate is tested combined with main from the canonical repo and cannot land while it fails', async () => {
  const f = await fixture();
  const inputsBefore = () => f.fake.inputs.length;
  let alone = 0;
  await landWhitespace(f, () => { alone = inputsBefore(); f.fake.output = VITEST_FAIL; f.fake.testExitCode = 1; });
  const view = await waitFor(`${f.base}/tasks/shape`, v => v.candidates[0]?.combined?.status === 'fail');
  const candidate = view.candidates[0], combined = candidate.combined;
  expect(candidate.tests).toMatchObject({ status: 'pass', passed: 22 });
  expect(combined).toMatchObject({ candidateSha: sha(2), conflicts: [], heddle: { conflictCount: 0, status: 'ready' } });
  expect(combined.tests).toMatchObject({ status: 'fail', passed: 19, failed: 3, provenance: 'isolated sandbox', sourceSha: combined.sha });
  expect(combined.tests.failures).toEqual(['test/read-table.test.ts > readTable > returns the header', 'test/read-table.test.ts > readTable > returns the body rows', 'test/read-table.test.ts > readTable > handles a header-only table']);
  expect(combined.tests.excerpt).toContain("expected [ ' Name ', ' Age ' ]");
  // The combined commit is fetched from the canonical repo with one short-lived read grant; never the fork.
  const job = f.fake.inputs.slice(alone).find(i => i.input.sourceSha === combined.sha)!;
  expect(job.input).toMatchObject({ remote: f.canonical, treeSha: combined.treeSha, agent: 'finn', task: 'shape' });
  expect(Object.keys(job.input).sort()).toEqual(['agent', 'project', 'readCredential', 'remote', 'sourceSha', 'task', 'treeSha']);
  expect(f.fake.destroyed).toContain(job.id);
  await runInDurableObject(f.project, instance => {
    const lease = instance.credentials.records().find(r => r.type === 'sandbox-read' && r.repo === f.p)!;
    expect(lease).toMatchObject({ owner: 'finn', status: 'revoked' });
    expect(memoryArtifacts.repos.get(f.p)!.issued.find(t => t.id === lease.id)).toMatchObject({ scope: 'read' });
    expect(JSON.stringify(instance.store.all('meta'))).not.toContain(job.input.readCredential);
    const recorded = instance.store.rows<any>("SELECT input FROM ops WHERE command='tests.record'").map(r => JSON.parse(r.input)).find(i => i.combined);
    expect(recorded).toMatchObject({ task: 'shape', agent: 'finn', sourceSha: sha(2), combined: { sha: combined.sha, mainSha: combined.mainSha } });
  });
  const refused = await api(`${f.base}/tasks/shape/decision`, { pick: 'finn', decider: 'luke', rationale: 'Ship it', expectHeads: view.heads });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: 'combined_failing', message: expect.stringContaining('3 tests fail combined with main') });
  // The board carries the same record.
  const board = await (await api(f.base)).json() as any;
  expect(board.tasks.find((t: any) => t.slug === 'shape').candidates[0].combined.tests.failed).toBe(3);
  // Idempotent: one combine per task and main, however often recovery runs.
  await runInDurableObject(f.project, async instance => { await (instance as any).refreshCombined(); await (instance as any).refreshCombined(); });
  const calls = (await f.engine.stats()).calls.filter((c: any) => c.command === 'combine');
  expect(calls).toHaveLength(1); expect(calls[0].input).toMatchObject({ task: 'shape', isolate: true, opId: `combine:shape:${combined.mainSha}` });
});
it('pending combined tests block landing; a passing combined result lands as the merged commit', async () => {
  const f = await fixture();
  await landWhitespace(f, () => { f.fake.delayMs = 4000; });
  const pending = await waitFor(`${f.base}/tasks/shape`, v => v.candidates[0]?.combined?.status === 'pending');
  const early = await api(`${f.base}/tasks/shape/decision`, { pick: 'finn', decider: 'luke', rationale: 'Ship it', expectHeads: pending.heads });
  expect(await early.json()).toMatchObject({ error: "combined_pending" }); expect(early.status).toBe(409);
  const passed = await waitFor(`${f.base}/tasks/shape`, v => v.candidates[0]?.combined?.status === 'pass');
  expect(passed.candidates[0].combined.tests).toMatchObject({ status: 'pass', passed: 22, failed: 0 });
  expect(passed.candidates[0].combined.tests.failures).toBeUndefined();
  const decision = await (await api(`${f.base}/tasks/shape/decision`, { pick: 'finn', decider: 'luke', rationale: 'Merged result passes', expectHeads: passed.heads })).json() as any;
  expect(decision.combined).toEqual({ sha: passed.candidates[0].combined.sha, treeSha: passed.candidates[0].combined.treeSha, mainSha: passed.candidates[0].combined.mainSha, state: passed.candidates[0].combined.state });
});
it('a candidate that conflicts with main is refused in Heddle terms; one that contains main needs no combined check', async () => {
  const f = await fixture();
  await f.engine.conflictWithMain(['finn']);
  await landWhitespace(f);
  const view = await waitFor(`${f.base}/tasks/shape`, v => v.candidates[0]?.combined?.status === 'conflict');
  expect(view.candidates[0].combined).toMatchObject({ conflicts: [{ path: 'src/table.ts', symbol: 'parseRow' }], heddle: { conflictCount: 1, status: 'blocked' } });
  expect(view.candidates[0].combined.sha).toBeUndefined();
  const refused = await api(`${f.base}/tasks/shape/decision`, { pick: 'finn', decider: 'luke', rationale: 'Ship it', expectHeads: view.heads });
  expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: 'combined_conflict', message: expect.stringContaining('src/table.ts (parseRow)') });
  // The agent takes main and pushes a head that contains it: its own tests are the combined result.
  await f.engine.markContainsMain([sha(3)]);
  await f.project.notePush(`${f.p}--shape--finn`, 'refs/heads/main', sha(3), 'event');
  const revised = await waitFor(`${f.base}/tasks/shape`, v => v.candidates[0]?.sourceSha === sha(3) && v.candidates[0]?.tests?.status === 'pass');
  expect(revised.candidates[0].combined).toBeUndefined();
  const decision = await (await api(`${f.base}/tasks/shape/decision`, { pick: 'finn', decider: 'luke', rationale: 'Resolved against main', expectHeads: revised.heads })).json() as any;
  expect(decision.mainSha).toMatch(/^[a-f0-9]{40}$/); expect(decision.combined).toBeUndefined();
});
