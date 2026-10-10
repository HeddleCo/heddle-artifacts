// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { SELF, env as testEnv, runInDurableObject, evictDurableObject } from 'cloudflare:test';
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
  return { p, base, joins, project: env.PROJECT.getByName(p), engine: env.ENGINE.getByName(p) as unknown as { stats(): Promise<any>; failNext(command: string, count?: number, after?: boolean): Promise<void>; loseDisk(): Promise<void>; delayNext(command: string, ms: number): Promise<void> } };
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
  it('A-T4 decision rejects missing/agent operator auth and stale exact heads', async () => {
    const { p, base, joins, project } = await setup();
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(200), 'event'); const task = await waitCandidates(base, 1);
    await ok(`${base}/humans`, { id: 'luke', displayName: 'Luke' });
    const body = { pick: 'agent-0', rationale: 'keep API stable', decider: 'luke', expectHeads: task.heads };
    expect((await api(`${base}/tasks/parser-escapes/decision`, body, null)).status).toBe(403);
    expect((await api(`${base}/tasks/parser-escapes/decision`, body, joins[0].agentKey)).status).toBe(403);
    const stale = await api(`${base}/tasks/parser-escapes/decision`, { ...body, expectHeads: ['old-head'] }); expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: 'stale', heads: task.heads });
    const decision = await ok(`${base}/tasks/parser-escapes/decision`, body); expect(decision.mainSha).toMatch(/^[a-f0-9]{40}$/);
    expect((await ok(base)).tasks[0].lanes[0].status).toBe('released');
    expect((await api(`${base}/agents/agent-0/token`, {}, joins[0].agentKey)).status).toBe(409);
    console.log('A-T4 PASS: missing token 403, agent token 403, stale heads 409, current heads land and revoke lane token');
  });
  it('failed publication retains readable metadata, revokes forks and an operator retry resumes the existing decision', async () => {
    const { p, base, project, engine } = await setup();
    await project.notePush(`${p}--parser-escapes--agent-0`, 'refs/heads/main', sha(250), 'event'); const task = await waitCandidates(base, 1);
    await ok(`${base}/humans`, { id: 'luke', displayName: 'Luke' });
    const body = { pick: 'agent-0', decider: 'luke', rationale: 'resume safely', expectHeads: task.heads };
    await engine.failNext('publish', 3, false);
    expect((await api(`${base}/tasks/parser-escapes/decision`, body)).status).toBe(503);
    const board = await ok(base); expect(board.tasks[0].decision.mainSha).toBe(''); expect(board.tasks[0].lanes[0].status).toBe('released');
    expect((await engine.stats()).calls.filter((c: any) => c.command === 'publish')).toHaveLength(3);
    expect((await api(`${base}/tasks/parser-escapes/decision`, { ...body, rationale: 'different decision' })).status).toBe(409);
    const landed = await ok(`${base}/tasks/parser-escapes/decision`, body); expect(landed.mainSha).toMatch(/^[a-f0-9]{40}$/);
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
    const cold = await ok(`${base}/tasks/parser-escapes`); expect(cold.candidates[0].sourceSha).toBe(sha(301));
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
  });
});
