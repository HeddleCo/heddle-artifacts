// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { SELF, env as testEnv, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import type { Env } from '../env';
import { memoryArtifacts } from '../../dev/memory-artifacts';
import { forkName } from '../artifacts';
import { routeEvent, queue } from '../events';
import { isMainPush } from '../../contracts/events';
const env = testEnv as unknown as Env;
const op = 'test-operator';
const sha = (n: number) => n.toString(16).padStart(40, '0');
async function api(path: string, body?: any, token: string | null = op) {
  const headers: Record<string, string> = {}; if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function ok(path: string, body?: any, token: string | null = op) {
  const response = await api(path, body, token), value = await response.json() as any;
  expect(response.status, JSON.stringify(value)).toBe(200); return value;
}
async function setup(count = 1) {
  const p = `p-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${p}`;
  await ok('/api/projects', { id: p, seed: { template: 'demo' } });
  await ok(`${base}/tasks`, { slug: 'parser-escapes', intent: 'support escaped pipes' });
  const joins = [];
  for (let i = 0; i < count; i++) joins.push(await ok(`${base}/tasks/parser-escapes/agents`, { id: `agent-${i}`, kind: 'agent', displayName: `Agent ${i}` }));
  return { p, base, joins, project: env.PROJECT.getByName(p), engine: env.ENGINE.getByName(p) as unknown as { stats(): Promise<any>; failNext(command: string, count?: number, after?: boolean, body?: string): Promise<void>; loseDisk(): Promise<void>; delayNext(command: string, ms: number): Promise<void> } };
}
async function waitCandidates(base: string, count: number) {
  let result: any;
  for (let i = 0; i < 100; i++) { result = await ok(`${base}/tasks/parser-escapes`); if (result.candidates.length === count) return result; await new Promise(r => setTimeout(r, 20)); }
  expect(result.candidates).toHaveLength(count); return result;
}

describe('Track A acceptance in real Workers + SQLite + R2 runtime', () => {
  it('A-T1 enrollment is idempotent, exact fork name and bounded hashed names', async () => {
    const { p, base, project, engine } = await setup();
    const first = await ok(base);
    const again = await ok(`${base}/tasks/parser-escapes/agents`, { id: 'agent-0', kind: 'agent', displayName: 'Agent 0' });
    const board = await ok(base);
    expect(board.agents).toHaveLength(1); expect(board.agents[0].publicKey).toBe(first.agents[0].publicKey);
    expect(board.tasks[0].lanes).toHaveLength(1); expect(board.tasks[0].lanes[0].forkRepo).toBe(`${p}--parser-escapes--agent-0`);
    expect(again.fork.remote).toContain(`${p}--parser-escapes--agent-0.git`);
    const stats = await engine.stats(); expect(stats.calls.filter((c: any) => c.command === 'agent.enroll')).toHaveLength(1); expect(stats.calls.filter((c: any) => c.command === 'lane.open')).toHaveLength(1);
    expect(await forkName('p'.repeat(63), 'task', 'alice')).toHaveLength(63);
    expect(await forkName('p'.repeat(63), 'task', 'alice')).not.toBe(await forkName('p'.repeat(63), 'task', 'bob'));
    await runInDurableObject(project, async (instance) => { const secretRows = JSON.stringify(instance.store.rows<any>('SELECT * FROM agents')); expect(secretRows).not.toContain(again.agentKey); expect(secretRows).toContain('keyHash'); });
    console.log('A-T1 PASS: one fork/lane/enroll op, stable public key, hashed long names, only agent-key hash persisted');
  });
  it('A-T2 duplicate Queue event plus poll produces exactly one ingest op', async () => {
    const { p, base, project, engine } = await setup(); const fork = `${p}--parser-escapes--agent-0`;
    memoryArtifacts.repos.get(fork)!.tip = sha(20);
    const event = { type: 'cf.artifacts.repo.pushed', source: { namespace: 'heddle-demo', repoName: fork }, payload: { ref: 'refs/heads/main', after: sha(20) } };
    await Promise.all([routeEvent(event, env), routeEvent(event, env), project.poll()]);
    const task = await waitCandidates(base, 1); expect(task.candidates[0].sourceSha).toBe(sha(20));
    const stats = await engine.stats(); expect(stats.calls.filter((c: any) => c.command === 'ingest')).toHaveLength(1);
    await runInDurableObject(project, instance => { expect(instance.store.rows<any>('SELECT * FROM pushes')).toHaveLength(1); expect(instance.store.rows<any>("SELECT * FROM ops WHERE command='ingest' AND status='done'")).toHaveLength(1); });
    console.log('A-T2 PASS: duplicate event + alarm poll => one push row, one durable ingest op, one capture');
  });
  it('journal opId retries bind command, semantic input and context before execution', async () => {
    const { project, engine } = await setup();
    await runInDurableObject(project, async instance => {
      const input = { opId: 'bound-operation', task: 'bound-task', intent: 'original intent' };
      const first = await instance.engine.mutate('task.create', input);
      expect(await instance.engine.mutate('task.create', { intent: input.intent, task: input.task, opId: input.opId })).toEqual(first);
      for (const [command, body, context] of [
        ['task.create', { ...input, intent: 'changed intent' }, {}],
        ['task.create', input, { review: 'changed context' }],
        ['agent.enroll', input, {}],
      ] as const) await expect(instance.engine.mutate(command, body, context)).rejects.toMatchObject({ status: 409, code: 'operation_mismatch' });
      // A pending receipt is bound too: a conflicting retry cannot replace the
      // authorized input that recovery will execute later.
      instance.store.storage.sql.exec("INSERT INTO ops (id,command,input,context,status) VALUES (?,?,?,?, 'pending')", 'pending-bound', 'task.create', JSON.stringify({ ...input, opId: 'pending-bound' }), '{}');
      await expect(instance.engine.mutate('task.create', { ...input, opId: 'pending-bound', intent: 'changed intent' })).rejects.toMatchObject({ status: 409, code: 'operation_mismatch' });
      instance.store.storage.sql.exec('DELETE FROM ops WHERE id=?', 'pending-bound');
    });
    expect((await engine.stats()).calls.filter((c: any) => c.input.opId === 'bound-operation')).toHaveLength(1);
  });
  it('A-T3 five concurrent pushes coalesce into one or two ingests and all capture', async () => {
    const { p, base, project, engine } = await setup(5);
    const accepted = await Promise.all(Array.from({ length: 5 }, (_, i) => project.notePush(`${p}--parser-escapes--agent-${i}`, 'refs/heads/main', sha(100 + i), 'event')));
    expect(accepted.every(Boolean)).toBe(true); const task = await waitCandidates(base, 5);
    expect(task.candidates.map((c: any) => c.sourceSha).sort()).toEqual(Array.from({ length: 5 }, (_, i) => sha(100 + i)).sort());
    const calls = (await engine.stats()).calls.filter((c: any) => c.command === 'ingest'); expect(calls.length).toBeGreaterThanOrEqual(1); expect(calls.length).toBeLessThanOrEqual(2); expect(calls.flatMap((c: any) => c.input.items)).toHaveLength(5);
    console.log(`A-T3 PASS: five pushes accepted, five captured, ${calls.length} ingest exec(s), no 429`);
  });
  it('A-T3 pushes received during an in-flight ingest become a second coalesced batch', async () => {
    const { p, base, project, engine } = await setup(5); await engine.delayNext('ingest', 250);
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(150), 'event');
    for (let i = 0; i < 50; i++) { if ((await engine.stats()).calls.some((c: any) => c.command === 'ingest')) break; await new Promise(r => setTimeout(r, 10)); }
    await Promise.all(Array.from({ length: 4 }, (_, i) => project.notePush(`${p}--parser-escapes--agent-${i + 1}`, 'refs/heads/main', sha(151 + i), 'event')));
    const task = await waitCandidates(base, 5); expect(task.candidates).toHaveLength(5);
    const calls = (await engine.stats()).calls.filter((c: any) => c.command === 'ingest'); expect(calls).toHaveLength(2); expect(calls.map((c: any) => c.input.items.length)).toEqual([1, 4]);
  });
  it('authenticated board snapshots remain responsive during a native ingest', async () => {
    const { p, base, project, engine } = await setup();
    await engine.delayNext('ingest', 1000);
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(170), 'event');
    for (let i = 0; i < 50; i++) {
      if ((await engine.stats()).calls.some((c: any) => c.command === 'ingest')) break;
      await new Promise(r => setTimeout(r, 10));
    }
    // These are committed coordinator snapshots, not speculative native results.
    const [board, task, denied] = await Promise.all([ok(base), ok(`${base}/tasks/parser-escapes`), api(base, undefined, null)]);
    expect(board.tasks).toHaveLength(1); expect(task.candidates).toHaveLength(0);
    expect(denied.status).toBe(403);
    const complete = await waitCandidates(base, 1);
    expect(complete.candidates[0].sourceSha).toBe(sha(170));
  });
  it('candidate snapshots publish only after complete native conflict refresh', async () => {
    const { p, base, project, engine } = await setup(2);
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(171), 'event');
    const original = await waitCandidates(base, 1);
    expect(original.candidates[0].conflicts).toHaveLength(0);
    const previousReads = (await engine.stats()).calls.filter((c: any) => c.command === 'candidates').length;
    await engine.delayNext('candidates', 1000);
    await project.notePush(`${p}--parser-escapes--agent-1`, 'refs/heads/main', sha(172), 'event');
    for (let i = 0; i < 100; i++) {
      if ((await engine.stats()).calls.filter((c: any) => c.command === 'candidates').length > previousReads) break;
      await new Promise(r => setTimeout(r, 10));
    }
    const during = await ok(`${base}/tasks/parser-escapes`);
    expect(during.candidates).toEqual(original.candidates);
    const complete = await waitCandidates(base, 2);
    for (const candidate of complete.candidates) expect(candidate.conflicts).toEqual([
      { path: 'src/table.ts', region: 'parseRow', with: [candidate.agent === 'agent-0' ? 'agent-1' : 'agent-0'] },
    ]);
  });
  it('A-T4 decision rejects missing/agent operator auth and stale exact heads', async () => {
    const { p, base, joins, project } = await setup();
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(200), 'event'); const task = await waitCandidates(base, 1);
    await ok(`${base}/humans`, { id: 'luke', displayName: 'Luke' });
    const body = { pick: 'agent-0', rationale: 'keep API stable', decider: 'luke', expectHeads: task.heads };
    expect((await api(`${base}/tasks/parser-escapes/decision`, body, null)).status).toBe(403);
    expect((await api(`${base}/tasks/parser-escapes/decision`, body, joins[0].agentKey)).status).toBe(403);
    const stale = await api(`${base}/tasks/parser-escapes/decision`, { ...body, expectHeads: ['old-head'] }); expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: 'stale', heads: task.heads });
    const decision = await ok(`${base}/tasks/parser-escapes/decision`, body); expect(decision.mainSha).toMatch(/^[a-f0-9]{40}$/);
    const why = await ok(`${base}/why/${decision.mainSha}`);
    expect(why.verify).toMatchObject({ sha: decision.mainSha, exportRoundTrip: true, treeMatch: true, fsck: true });
    expect(Number.isFinite(Date.parse(why.verify.checkedAt))).toBe(true);
    await runInDurableObject(project, instance => instance.store.put('meta', 'verify', { exportRoundTrip: false, treeMatch: false, fsck: false }));
    expect((await ok(`${base}/why/${decision.mainSha}`)).verify).toEqual(why.verify);
    expect((await ok(`${base}/why/${sha(200)}`)).verify).toBeUndefined();
    expect((await ok(base)).tasks[0].lanes[0].status).toBe('released');
    expect((await api(`${base}/agents/agent-0/token`, {}, joins[0].agentKey)).status).toBe(409);
    console.log('A-T4 PASS: missing token 403, agent token 403, stale heads 409, current heads land and revoke lane token');
  });
  it('decision anchor/tag validation precedes mutations and passes exact values to the engine', async () => {
    const { p, base, project, engine } = await setup();
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(240), 'event');
    const task = await waitCandidates(base, 1);
    await ok(`${base}/humans`, { id: 'luke', displayName: 'Luke' });
    const body = { pick: 'agent-0', decider: 'luke', rationale: 'Whitespace belongs to parseRow.', expectHeads: task.heads };
    for (const invalid of [
      { anchor: null }, { anchor: '' }, { anchor: '/src/table.ts' }, { anchor: '../src/table.ts' }, { anchor: 'src//table.ts' },
      { anchor: 'src/table.ts:' }, { anchor: 'src/table.ts:bad-name' }, { anchor: 'src/table.ts:parseRow\n' }, { anchor: 'src/table.ts:parseRow:extra' },
      { anchor: 'missing.ts:parseRow' }, { anchor: 'src' },
      { tags: null }, { tags: 'whitespace' }, { tags: [''] }, { tags: ['bad tag'] }, { tags: ['whitespace\n'] }, { tags: [2] },
      { tags: ['x'.repeat(65)] }, { tags: Array(9).fill('x') },
    ]) {
      const response = await api(`${base}/tasks/parser-escapes/decision`, { ...body, ...invalid });
      expect(response.status, JSON.stringify(invalid)).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'anchor' in invalid ? 'invalid_anchor' : 'invalid_tags', message: expect.any(String) });
    }
    expect((await engine.stats()).calls.filter((c: any) => ['decide', 'publish'].includes(c.command))).toHaveLength(0);
    await runInDurableObject(project, instance => {
      expect(instance.store.get('decisions', 'parser-escapes')).toBeUndefined();
      expect(instance.store.rows("SELECT * FROM ops WHERE command IN ('decide','publish')")).toHaveLength(0);
    });
    await (engine as any).setTreeFiles(task.candidates[0].treeSha, ['src/table.ts', 'src/added.ts']);
    const absentFromPick = await api(`${base}/tasks/parser-escapes/decision`, { ...body, anchor: 'README.md' });
    expect(absentFromPick.status).toBe(400);
    expect(await absentFromPick.json()).toMatchObject({ error: 'invalid_anchor' });
    const exact = { ...body, anchor: 'src/table.ts:parseRow', tags: ['parseRow', 'whitespace', 'a'.repeat(64), '_.:/-'] };
    const decision = await ok(`${base}/tasks/parser-escapes/decision`, exact);
    expect(decision).toMatchObject({ anchor: exact.anchor, tags: exact.tags });
    expect((await engine.stats()).calls.find((c: any) => c.command === 'decide').input).toMatchObject(exact);
    const stored = (await ok(`${base}/tasks/parser-escapes`)).decision;
    expect(stored).toMatchObject({ anchor: exact.anchor, tags: exact.tags });
    await ok(`${base}/tasks`, { slug: 'next-task', intent: 'Read earlier decision context' });
    const next = await ok(`${base}/tasks/next-task/agents`, { id: 'later', kind: 'agent', displayName: 'Later' });
    expect(next.briefing.annotations[0]).toMatchObject({ target: 'src/table.ts', scope: 'symbol:parseRow', tags: exact.tags });
  });
  it('file-only anchor and eight tags are accepted', async () => {
    const { p, base, project, engine } = await setup();
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(241), 'event');
    const task = await waitCandidates(base, 1);
    await ok(`${base}/humans`, { id: 'luke', displayName: 'Luke' });
    const body = { pick: 'agent-0', decider: 'luke', rationale: 'File rule', expectHeads: task.heads, anchor: 'src/table.ts', tags: Array.from({ length: 8 }, (_, i) => `tag${i}`) };
    expect(await ok(`${base}/tasks/parser-escapes/decision`, body)).toMatchObject({ anchor: body.anchor, tags: body.tags });
    expect((await engine.stats()).calls.find((c: any) => c.command === 'decision.validate').input.anchor).toBe(body.anchor);
  });
  it('failed publication retains readable metadata, revokes forks and an operator retry resumes the existing decision', async () => {
    const { p, base, project, engine } = await setup();
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(250), 'event'); const task = await waitCandidates(base, 1);
    await ok(`${base}/humans`, { id: 'luke', displayName: 'Luke' });
    const body = { pick: 'agent-0', decider: 'luke', rationale: 'resume safely', expectHeads: task.heads, anchor: 'src/table.ts:parseRow', tags: ['whitespace'] };
    await engine.failNext('publish', 3, false);
    expect((await api(`${base}/tasks/parser-escapes/decision`, body)).status).toBe(503);
    const board = await ok(base); expect(board.tasks[0].decision.mainSha).toBe(''); expect(board.tasks[0].lanes[0].status).toBe('released');
    await runInDurableObject(project, instance => {
      const before = instance.store.get('meta', 'mainSha');
      const expected = instance.store.get<string>('meta', 'decisionMain:parser-escapes');
      for (const failed of ['exportRoundTrip', 'treeMatch', 'fsck']) {
        const verify = { exportRoundTrip: true, treeMatch: true, fsck: true, [failed]: false };
        expect(() => (instance as any).apply('publish', {}, { main: expected, verify }, {})).toThrow('invalid_publish_verification');
        expect(instance.store.get('meta', 'mainSha')).toBe(before);
        expect(instance.store.get<any>('decisions', 'parser-escapes').mainSha).toBe('');
        expect(instance.store.get('meta', `verify:${expected}`)).toBeUndefined();
        expect(instance.store.get<any>('tasks', 'parser-escapes').status).toBe('open');
      }
      expect(() => (instance as any).apply('publish', {}, { main: sha(9999), verify: { exportRoundTrip: true, treeMatch: true, fsck: true } }, {})).toThrow('publication_decision_mismatch');
      expect(instance.store.get('meta', 'mainSha')).toBe(before);
      expect(instance.store.get<any>('decisions', 'parser-escapes').mainSha).toBe('');
    });
    const blocked = await api(`${base}/tasks`, { slug: 'later-task', intent: 'Must wait for the prior publication' });
    expect(blocked.status).toBe(409); expect(await blocked.json()).toEqual({ error: 'publication_pending', task: 'parser-escapes' });
    expect((await engine.stats()).calls.filter((c: any) => c.command === 'publish')).toHaveLength(3);
    expect((await api(`${base}/tasks/parser-escapes/decision`, { ...body, rationale: 'different decision' })).status).toBe(409);
    expect((await api(`${base}/tasks/parser-escapes/decision`, { ...body, anchor: 'README.md' })).status).toBe(409);
    expect((await api(`${base}/tasks/parser-escapes/decision`, { ...body, tags: ['different'] })).status).toBe(409);
    const landed = await ok(`${base}/tasks/parser-escapes/decision`, body);
    expect(landed).toMatchObject({ anchor: body.anchor, tags: body.tags }); expect(landed.mainSha).toMatch(/^[a-f0-9]{40}$/);
    await runInDurableObject(project, instance => expect(instance.store.get('meta', 'decisionMain:parser-escapes')).toBe(landed.mainSha));
    expect((await api(`${base}/tasks`, { slug: 'later-task', intent: 'Prior publication is complete' })).status).toBe(200);
    const calls = (await engine.stats()).calls; expect(calls.filter((c: any) => c.command === 'decide')).toHaveLength(1);
    expect(calls.filter((c: any) => c.command === 'publish').every((c: any) => c.hasCanonicalRead)).toBe(true);
  });
  it('A-T5 crash mid-ingest restores R2 and replays the same journaled op after DO eviction', async () => {
    const { p, base, project, engine } = await setup();
    const before = await runInDurableObject(project, instance => instance.store.get<number>('meta', 'stateGeneration'));
    await engine.failNext('ingest', 1, true);
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(300), 'event');
    const task = await waitCandidates(base, 1); const state = (await engine.stats()).state;
    expect(Object.values(state.candidates)).toHaveLength(1); expect(task.candidates[0].signedBy).toBe(state.agents['agent-0'].publicKey);
    const calls = (await engine.stats()).calls.filter((c: any) => c.command === 'ingest'); expect(calls).toHaveLength(2); expect(calls[0].input.opId).toBe(calls[1].input.opId);
    await runInDurableObject(project, instance => { expect(instance.store.get<number>('meta', 'stateGeneration')).toBe(before! + 1); expect(instance.store.rows<any>("SELECT status,attempts FROM ops WHERE command='ingest'")).toEqual([{ status: 'done', attempts: 2 }]); });
    await engine.loseDisk(); await evictDurableObject(project);
    const diff = await api(`${base}/tasks/parser-escapes/candidates/agent-0/diff`); expect(diff.status).toBe(200); expect(await diff.text()).toContain('agent-0');
    expect((await engine.stats()).state.candidates).toEqual(state.candidates);
    // Simulate process death after exec but before generation commit: the DO
    // journal remains pending, while both coordinator memory and engine disk vanish.
    const input = { opId: 'cold-replay', items: [{ task: 'parser-escapes', agent: 'agent-0', fork: { remote: memoryArtifacts.repos.get(`${p}--parser-escapes--agent-0`)!.info.remote }, ref: 'refs/heads/main', sha: sha(301) }], runTests: true };
    await runInDurableObject(project, instance => {
      instance.store.storage.sql.exec("INSERT INTO pushes (id,lane,sha,data,status) VALUES (?,?,?,?,'pending')", `parser-escapes/agent-0:${sha(301)}`, 'parser-escapes/agent-0', sha(301), JSON.stringify(input.items[0]));
      instance.store.storage.sql.exec("INSERT INTO ops (id,command,input,context,status) VALUES (?,?,?,?,'pending')", input.opId, 'ingest', JSON.stringify(input), '{}');
    });
    await engine.loseDisk(); await evictDurableObject(project);
    // Reads return committed snapshots immediately and schedule recovery in the
    // background. Poll the exact new head rather than expecting GET to block.
    let cold;
    for (let i = 0; i < 100; i++) {
      cold = await ok(`${base}/tasks/parser-escapes`);
      if (cold.candidates[0]?.sourceSha === sha(301)) break;
      await new Promise(r => setTimeout(r, 20));
    }
    expect(cold.candidates[0].sourceSha).toBe(sha(301));
    await runInDurableObject(project, instance => { expect(instance.store.get<number>('meta', 'stateGeneration')).toBe(before! + 2); expect(instance.store.rows<any>("SELECT status FROM ops WHERE id='cold-replay'")).toEqual([{ status: 'done' }]); });
    console.log('A-T5 PASS: partial mutation + lost engine disk => R2 restore, same opId replay, one generation/candidate; pending journal replays after coordinator eviction');
  });
  it('queue acknowledges durable receipt, retries routing failures, and reviewer posts with its enrolled key', async () => {
    const { p, base, project } = await setup(2);
    await ok(`${base}/tasks/parser-escapes/agents`, { id: 'reviewer', kind: 'reviewer', displayName: 'Reviewer' });
    const event = { type: 'cf.artifacts.repo.pushed', source: { namespace: 'heddle-demo', repoName: `${p}--parser-escapes--agent-0` }, payload: { ref: 'refs/heads/main', after: sha(600) } };
    let acked = 0, retried = 0;
    await queue({ messages: [{ body: event, ack() { acked++; }, retry() { retried++; } }] } as unknown as MessageBatch<unknown>, env);
    expect(acked).toBe(1); expect(retried).toBe(0);
    const unavailable = { ...env, PROJECT: { getByName() { return { async lookupFork() { throw new Error('fixture unavailable'); } }; } } } as unknown as Env;
    await queue({ messages: [{ body: event, ack() { acked++; }, retry() { retried++; } }] } as unknown as MessageBatch<unknown>, unavailable);
    expect(acked).toBe(1); expect(retried).toBe(1);
    await project.notePush(`${p}--parser-escapes--agent-1`, 'refs/heads/main', sha(601), 'event');
    await waitCandidates(base, 2);
    await runInDurableObject(project, async instance => { instance.store.put('meta', 'reviewDue:parser-escapes', 1); await instance.alarm(); });
    const task = await ok(`${base}/tasks/parser-escapes`), board = await ok(base);
    expect(task.review.model).toBe('stub'); expect(task.turns).toHaveLength(1); expect(task.turns[0].author).toBe('reviewer');
    expect(task.turns[0].signedBy).toBe(board.agents.find((a: any) => a.id === 'reviewer').publicKey);
  });
  it('routes only main on a registered fork; dev hook is 404 outside DEV=1', async () => {
    const { p, project, engine } = await setup();
    expect(await project.notePush(`${p}--parser-escapes--unknown`, 'refs/heads/main', sha(400), 'event')).toBe(false);
    expect(await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/other', sha(400), 'event')).toBe(false);
    expect(await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', '0'.repeat(40), 'event')).toBe(false);
    expect(isMainPush({ type: 'cf.artifacts.repo.pushed', source: { repoName: 'x' }, payload: { ref: 'refs/heads/main', after: 'bad' } })).toBe(false);
    expect((await api('/__dev/events', {})).status).toBe(404); expect((await engine.stats()).calls.filter((c: any) => c.command === 'ingest')).toHaveLength(0);
  });
  it('agent cannot impersonate another identity; private why and cross-origin cookie writes fail closed', async () => {
    const { base, joins } = await setup(); await ok(`${base}/humans`, { id: 'luke', displayName: 'Luke' });
    expect((await api(`${base}/tasks/parser-escapes/turns`, { body: 'reply', as: 'luke' }, joins[0].agentKey)).status).toBe(403);
    const turn = await ok(`${base}/tasks/parser-escapes/turns`, { body: 'reply' }, joins[0].agentKey); expect(turn.author).toBe('agent-0');
    expect((await api(`${base}/why/${sha(1)}`, undefined, null)).status).toBe(403);
    const cross = await SELF.fetch(`https://heddle.test${base}/humans`, { method: 'POST', headers: { authorization: `Bearer ${op}`, origin: 'https://other.test' }, body: JSON.stringify({ id: 'other', displayName: 'Other' }) }); expect(cross.status).toBe(403);
    const login = await SELF.fetch('https://heddle.test/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token: op }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } }); expect(login.status).toBe(303); expect(login.headers.get('set-cookie')).toContain('HttpOnly'); expect(login.headers.get('set-cookie')).toContain('Secure');
    const cookie = login.headers.get('set-cookie')!.split(';')[0]; expect((await SELF.fetch(`https://heddle.test${base}`, { headers: { cookie } })).status).toBe(200);
  });
  it('the demo project serves public board, task and Why reads but keeps writes, credentials and the feed private', async () => {
    const base = '/api/projects/demo';
    await ok('/api/projects', { id: 'demo', seed: { template: 'demo' } });
    await ok(`${base}/tasks`, { slug: 'parser-escapes', intent: 'support escaped pipes' });
    const joined = await ok(`${base}/tasks/parser-escapes/agents`, { id: 'agent-0', kind: 'agent', displayName: 'Agent 0' });
    const board = await api(base, undefined, null); expect(board.status).toBe(200);
    const text = await board.text(); expect(JSON.parse(text).agents).toHaveLength(1);
    for (const secret of [joined.agentKey, joined.fork.token, joined.upstream.readToken, op]) expect(text).not.toContain(secret);
    expect((await api(`${base}/tasks/parser-escapes`, undefined, null)).status).toBe(200);
    expect((await api(base, undefined, 'stale-cookie-or-token')).status).toBe(200);
    expect((await api(`${base}/tasks/parser-escapes/turns`, { body: 'anonymous' }, null)).status).toBe(403);
    expect((await api(`${base}/humans`, { id: 'guest', displayName: 'Guest' }, null)).status).toBe(403);
    expect((await api(`${base}/credentials`, undefined, null)).status).toBe(403);
    expect((await SELF.fetch(`https://heddle.test${base}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(403);
    const { base: other } = await setup(); expect((await api(other, undefined, null)).status).toBe(403);
  });
  it('operator diagnostics expose queue states without credentials or payloads', async () => {
    const { p, base, joins, project } = await setup(); const fork = `${p}--parser-escapes--agent-0`;
    await runInDurableObject(project, async instance => { instance.store.put('meta', 'reviewAttempt:parser-escapes:abc', { status: 'prepared', heads: [], createdAt: '2026-10-12T00:00:00.000Z',
      review: { model: 'fallback', summary: 'prompt text must not leak' }, diagnostics: [{ reason: 'deadline', attempt: 1, elapsedMs: 90000 }] }); });
    memoryArtifacts.repos.get(fork)!.tip = sha(30);
    await routeEvent({ type: 'cf.artifacts.repo.pushed', source: { namespace: 'heddle-demo', repoName: fork }, payload: { ref: 'refs/heads/main', after: sha(30) } }, env);
    await waitCandidates(base, 1);
    const response = await api(`${base}/diagnostics`); expect(response.status).toBe(200);
    const text = await response.text(), d = JSON.parse(text);
    expect(d.open).toBe(true); expect(d.pushes.map((x: any) => x.status)).toContain('done');
    expect(d.ops.some((o: any) => o.command === 'ingest' && o.status === 'done')).toBe(true);
    for (const secret of [joins[0].agentKey, joins[0].fork.token, joins[0].upstream.readToken, op]) expect(text).not.toContain(secret);
    expect(d.reviews).toEqual([{ id: 'parser-escapes:abc', status: 'prepared', createdAt: '2026-10-12T00:00:00.000Z', model: 'fallback', diagnostics: [{ reason: 'deadline', attempt: 1, elapsedMs: 90000 }] }]);
    expect(text).not.toContain('prompt text must not leak');
    expect((await api(`${base}/diagnostics`, undefined, null)).status).toBe(403);
    expect((await api(`${base}/diagnostics`, undefined, joins[0].agentKey)).status).toBe(403);
  });
  it('HTTP JSON and login bodies are bounded before parsing', async () => {
    const response = await api('/api/projects', { id: 'bounded', seed: { template: 'demo' }, extra: 'x'.repeat(65536) }); expect(response.status).toBe(413);
    const login = await SELF.fetch('https://heddle.test/login', { method: 'POST', body: 'token=' + 'x'.repeat(4096) }); expect(login.status).toBe(413);
  });
  it('three crashes emit engine.error and domain rejections do not retry', async () => {
    const { p, base, project, engine } = await setup(); await engine.failNext('ingest', 3, false);
    const ws = await api(`${base}/ws`); expect(ws.status).toBe(426);
    const response = await SELF.fetch(`https://heddle.test${base}/ws`, { headers: { authorization: `Bearer ${op}`, upgrade: 'websocket' } });
    expect(response.status).toBe(101); const socket = response.webSocket!; socket.accept(); const messages: any[] = []; socket.addEventListener('message', event => { messages.push(JSON.parse(event.data as string)); });
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(500), 'event');
    for (let i = 0; i < 100 && !messages.some(e => e.type === 'engine.error'); i++) await new Promise(r => setTimeout(r, 20));
    expect(messages.some(e => e.type === 'engine.error' && e.code === 'crash')).toBe(true); expect((await engine.stats()).calls.filter((c: any) => c.command === 'ingest')).toHaveLength(3);
    socket.close();
    // A crash without a structured body still names a reason for the operator.
    const d = await (await api(`${base}/diagnostics`)).json() as any;
    expect(d.ops.find((o: any) => o.command === 'ingest')).toMatchObject({ status: 'failed', error: 'engine_failed', reason: 'engine_crash' });
  });
  it('a crashed ingest is retried later, twice, before the push counts as failed', async () => {
    const { p, base, project, engine } = await setup();
    const pushes = async () => ((await (await api(`${base}/diagnostics`)).json()) as any).pushes.map((x: any) => x.status);
    const settle = async (status: string) => { for (let i = 0; i < 200 && !(await pushes()).includes(status); i++) await new Promise(r => setTimeout(r, 20)); };
    // Bring every scheduled retry forward, then let the alarm drain.
    const due = async () => { await runInDurableObject(project, instance => { for (const row of instance.store.rows<{ key: string; data: string }>("SELECT key,data FROM meta WHERE key LIKE 'pushRetry:%'")) instance.store.put('meta', row.key, { ...JSON.parse(row.data), notBefore: 0 }); }); await runDurableObjectAlarm(project).catch(() => {}); };
    await engine.failNext('ingest', 3, false);
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(530), 'event');
    await settle('retry'); expect(await pushes()).toEqual(['retry']);
    await runInDurableObject(project, instance => { const r = instance.store.get<any>('meta', `pushRetry:${instance.store.rows<{ id: string }>('SELECT id FROM pushes')[0].id}`); expect(r.count).toBe(1); expect(r.notBefore).toBeGreaterThan(Date.now() + 50000); });
    await due(); await settle('done');
    expect(await pushes()).toEqual(['done']); await waitCandidates(base, 1);
    expect((await engine.stats()).calls.filter((c: any) => c.command === 'ingest')).toHaveLength(4);
    // A push that keeps failing stops after two retries.
    const second = await setup();
    await second.engine.failNext('ingest', 9, false);
    await second.project.notePush(`${second.p}--parser-escapes--agent-0`, 'refs/heads/main', sha(531), 'event');
    const statuses = async () => ((await (await api(`${second.base}/diagnostics`)).json()) as any).pushes.map((x: any) => x.status);
    const until = async (status: string) => { for (let i = 0; i < 200 && !(await statuses()).includes(status); i++) await new Promise(r => setTimeout(r, 20)); };
    const bring = async () => { await runInDurableObject(second.project, instance => { for (const row of instance.store.rows<{ key: string; data: string }>("SELECT key,data FROM meta WHERE key LIKE 'pushRetry:%'")) instance.store.put('meta', row.key, { ...JSON.parse(row.data), notBefore: 0 }); }); await runDurableObjectAlarm(second.project).catch(() => {}); };
    await until('retry'); await bring(); await new Promise(r => setTimeout(r, 300)); await until('retry'); await bring(); await until('failed');
    expect(await statuses()).toEqual(['failed']);
    expect((await second.engine.stats()).calls.filter((c: any) => c.command === 'ingest')).toHaveLength(9);
  });
  it('reads and operations skip the restore while the engine container still holds the current snapshot', async () => {
    const { p, base, joins, project, engine } = await setup();
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(540), 'event'); await waitCandidates(base, 1);
    const count = async (command: string) => (await engine.stats()).calls.filter((c: any) => c.command === command).length;
    const diff = async () => { const r = await api(`${base}/tasks/parser-escapes/candidates/agent-0/diff`); expect(r.status).toBe(200); return r.text(); };
    // Warm: the last operation left exactly the current generation on disk, so neither read restores.
    let restores = await count('restore');
    const first = await diff(); expect(await diff()).toBe(first);
    expect(await count('restore')).toBe(restores); expect(await count('loaded')).toBeGreaterThan(0);
    // A restarted container holds no token: the next read restores, and reads the right state.
    await engine.loseDisk();
    expect(await diff()).toBe(first); expect(await count('restore')).toBe(restores + 1);
    restores = await count('restore');
    // An attempt that fails may leave its disk changed, so the retry restores before running again.
    await engine.failNext('discuss', 1, true);
    expect((await api(`${base}/tasks/parser-escapes/turns`, { body: 'after a failed attempt' }, joins[0].agentKey)).status).toBe(200);
    const calls = (await engine.stats()).calls.map((c: any) => c.command);
    const failedAt = calls.lastIndexOf('discuss', calls.lastIndexOf('discuss') - 1);
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(calls.slice(failedAt + 1, calls.lastIndexOf('discuss'))).toContain('restore');
    expect(await count('restore')).toBe(restores + 1);
  });
  it('a failed op keeps the engine reason code and frames for diagnostics, and nothing else', async () => {
    const { p, base, project, engine } = await setup();
    const crash = (error: object) => JSON.stringify({ error: { code: 'engine_failure', message: 'Engine operation failed', ...error } });
    await engine.failNext('ingest', 3, false, crash({ reason: 'git_push_auth', at: ['engine/lib/commands.mjs:204:23', 'https://user:leak@example.test/x.mjs:1:1'] }));
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(510), 'event');
    const failed = async () => { for (let i = 0; i < 200; i++) { const d = await (await api(`${base}/diagnostics`)).json() as any; const o = d.ops.find((x: any) => x.command === 'ingest' && x.status === 'failed'); if (o) return o; await new Promise(r => setTimeout(r, 20)); } };
    expect(await failed()).toMatchObject({ error: 'engine_failed', reason: 'git_push_auth', at: ['engine/lib/commands.mjs:204:23'] });
    // A reason outside the fixed vocabulary is replaced, so stderr-like text never reaches the operator view.
    const { p: q, base: other, project: second, engine: secondEngine } = await setup();
    await secondEngine.failNext('ingest', 3, false, crash({ reason: 'Authorization: Bearer leaked-secret' }));
    await second.notePush(`${q}--parser-escapes--agent-0`, 'refs/heads/main', sha(520), 'event');
    let text = '';
    for (let i = 0; i < 200 && !text.includes('"failed"'); i++) { text = await (await api(`${other}/diagnostics`)).text(); await new Promise(r => setTimeout(r, 20)); }
    expect(JSON.parse(text).ops.find((o: any) => o.command === 'ingest')).toMatchObject({ status: 'failed', reason: 'engine_crash' });
    expect(text).not.toContain('leaked-secret');
  });
});
