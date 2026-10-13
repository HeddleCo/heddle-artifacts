// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { SELF, env as testEnv, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../env';
const env = testEnv as unknown as Env;
async function api(path: string, body?: unknown) {
  return SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer test-operator', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function setup() {
  const p = `email-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${p}`;
  expect((await api('/api/projects', { id: p, seed: { template: 'demo' } })).status).toBe(200);
  return { p, base, project: env.PROJECT.getByName(p), engine: env.ENGINE.getByName(p) as unknown as { stats(): Promise<any> } };
}
it('human email is optional; valid addresses reach the worker record and stub engine unchanged', async () => {
  const { base, engine } = await setup();
  const boundary = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  expect(boundary.length).toBe(254);
  for (const [i, email] of [undefined, 'luke@heddle.sh', 'Luke.Decider+demo@sub-domain.example.com', "o'connor@example.co", boundary].entries()) {
    const id = `human-${i}`, agent = { id, displayName: 'Human', ...(email === undefined ? {} : { email }) };
    expect((await api(`${base}/humans`, agent)).status).toBe(200);
    const stats = await engine.stats();
    expect(stats.calls.find((c: any) => c.command === 'agent.enroll' && c.input.agent.id === id).input.agent).toEqual({ ...agent, kind: 'human' });
    expect(stats.state.agents[id]).toMatchObject({ ...agent, kind: 'human' });
    const board = await (await api(base)).json() as any;
    expect(board.agents.find((a: any) => a.id === id)).toMatchObject({ ...agent, kind: 'human' });
    if (email === undefined) expect(stats.state.agents[id]).not.toHaveProperty('email');
  }
});
it('invalid email returns invalid_email before enrollment or persistent side effects', async () => {
  const { base, project, engine } = await setup();
  // Invalid registration must not even replay a previously pending enrollment during recovery.
  await runInDurableObject(project, async instance => {
    instance.store.storage.sql.exec('INSERT INTO ops (id,command,input,context,status) VALUES (?,?,?,?,?)',
      'pending-enroll', 'agent.enroll', JSON.stringify({ opId: 'pending-enroll', agent: { id: 'pending', kind: 'human', displayName: 'Pending' } }), '{}', 'pending');
  });
  const before = await engine.stats();
  const invalid = [null, 123, true, {}, [], '', 'luke', '@heddle.sh', 'luke@', 'luke@localhost',
    'Luke <luke@heddle.sh>', '<luke@heddle.sh>', 'luke@heddle.sh,other@example.com', 'luke@@heddle.sh',
    ' luke@heddle.sh', 'luke@heddle.sh ', 'lu ke@heddle.sh', 'luke@heddle.sh\n', 'luke@heddle.sh\r\n',
    'lu\tke@heddle.sh', 'lu\0ke@heddle.sh', 'lu\x1fke@heddle.sh', 'lu\x7fke@heddle.sh', 'luke@heddle.sh\u00a0',
    '"luke"@heddle.sh', '.luke@heddle.sh', 'luke..name@heddle.sh', 'luke.@heddle.sh',
    'luke@.heddle.sh', 'luke@heddle..sh', 'luke@heddle.sh.', 'luke@-heddle.sh', 'luke@heddle-.sh',
    'luke@heddle_sh.example', 'luke@[127.0.0.1]', `${'a'.repeat(245)}@heddle.sh`];
  for (const email of invalid) {
    const response = await api(`${base}/humans`, { id: 'invalid', displayName: 'Invalid', email });
    expect(response.status, JSON.stringify(email)).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_email' });
  }
  expect(await engine.stats()).toEqual(before);
  await runInDurableObject(project, async instance => {
    expect(instance.store.all('agents')).toEqual([]);
    expect(instance.store.rows<{ status: string }>("SELECT status FROM ops WHERE command='agent.enroll'")).toEqual([{ status: 'pending' }]);
  });
  console.log(`PASS human email: ${invalid.length} invalid values rejected before enrollment side effects`);
});
it('same human email is idempotent; changed, removed or added email conflicts without mutation', async () => {
  const { base, engine } = await setup();
  const agent = { id: 'luke', displayName: 'Luke', email: 'luke@heddle.sh' };
  const first = await (await api(`${base}/humans`, agent)).json();
  expect(await (await api(`${base}/humans`, agent)).json()).toEqual(first);
  const before = await engine.stats();
  for (const email of ['other@heddle.sh', undefined]) {
    const response = await api(`${base}/humans`, { ...agent, email });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'identity_exists' });
  }
  expect(await engine.stats()).toEqual(before);
  expect((await api(`${base}/humans`, { id: 'legacy', displayName: 'Legacy' })).status).toBe(200);
  const response = await api(`${base}/humans`, { id: 'legacy', displayName: 'Legacy', email: 'legacy@example.com' });
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'identity_exists' });
  expect((await engine.stats()).calls.filter((c: any) => c.command === 'agent.enroll' && c.input.agent.id === 'luke')).toHaveLength(1);
});
it('a human cannot replace an existing agent identity', async () => {
  const { base, engine } = await setup();
  expect((await api(`${base}/tasks`, { slug: 't', intent: 'Email fixture' })).status).toBe(200);
  expect((await api(`${base}/tasks/t/agents`, { id: 'agent', kind: 'agent', displayName: 'Agent' })).status).toBe(200);
  const before = await engine.stats();
  const response = await api(`${base}/humans`, { id: 'agent', displayName: 'Human', email: 'human@example.com' });
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'identity_exists' });
  expect(await engine.stats()).toEqual(before);
});
