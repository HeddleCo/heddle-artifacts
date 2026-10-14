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

it('sponsor registration is explicit, durable and idempotent; a different sponsor conflicts', async () => {
  const { base, project, engine } = await setup();
  const agent = { id: 'luke', displayName: 'Luke', email: 'luke@heddle.sh', sponsor: true };
  // Several other humans may have email; none is implicitly the sponsor.
  expect((await api(`${base}/humans`, { id: 'other', displayName: 'Other', email: 'other@example.com' })).status).toBe(200);
  const first = await api(`${base}/humans`, agent); expect(first.status).toBe(200);
  const body = await first.json();
  expect(await (await api(`${base}/humans`, agent)).json()).toEqual(body);
  expect(await (await api(`${base}/humans`, { ...agent, sponsor: undefined })).json()).toEqual(body);
  const stats = await engine.stats();
  expect(stats.calls.filter((c: any) => c.command === 'agent.enroll' && c.input.agent.sponsor)).toHaveLength(1);
  expect(stats.state.agents.luke).toMatchObject({ ...agent, kind: 'human' });
  await runInDurableObject(project, async instance => {
    expect(instance.store.get('agents', 'luke')).toMatchObject({ ...agent, kind: 'human' });
  });
  for (const candidate of [{ id: 'another', displayName: 'Another', email: 'another@example.com', sponsor: true },
    { id: 'other', displayName: 'Other', email: 'other@example.com', sponsor: true }]) {
    const response = await api(`${base}/humans`, candidate);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'sponsor_exists' });
  }
  expect(await engine.stats()).toEqual(stats);
});
it('a registered human with the same email can become sponsor without replacing the identity', async () => {
  const { base, project } = await setup();
  const human = { id: 'luke', displayName: 'Luke', email: 'luke@heddle.sh' };
  const before = await (await api(`${base}/humans`, human)).json();
  expect(await (await api(`${base}/humans`, { ...human, sponsor: true })).json()).toEqual(before);
  await runInDurableObject(project, async instance => { expect(instance.store.get('agents', human.id).sponsor).toBe(true); });
});
it('sponsor without email or with a nonboolean designation is rejected before recovery or enrollment', async () => {
  const { base, project, engine } = await setup();
  await runInDurableObject(project, async instance => {
    instance.store.storage.sql.exec('INSERT INTO ops (id,command,input,context,status) VALUES (?,?,?,?,?)',
      'pending-sponsor', 'agent.enroll', JSON.stringify({ opId: 'pending-sponsor', agent: { id: 'pending', kind: 'human', displayName: 'Pending' } }), '{}', 'pending');
  });
  const before = await engine.stats();
  for (const candidate of [{ sponsor: true }, { email: 'luke@heddle.sh', sponsor: 'true' }, { email: 'luke@heddle.sh', sponsor: null }]) {
    const response = await api(`${base}/humans`, { id: 'invalid', displayName: 'Invalid', ...candidate });
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_sponsor' });
  }
  expect(await engine.stats()).toEqual(before);
  await runInDurableObject(project, async instance => { expect(instance.store.all('agents')).toEqual([]); });
});
it('the worker preserves the engine address in durable enrollment state', async () => {
  const { base, project } = await setup();
  await runInDurableObject(project, async instance => {
    (instance as any).apply('agent.enroll', { agent: { id: 'gwen', kind: 'agent', displayName: 'Gwen' } },
      { publicKey: 'a'.repeat(64), address: 'luke+gwen@heddle.sh' }, {});
    expect(instance.store.get('agents', 'gwen').address).toBe('luke+gwen@heddle.sh');
  });
  const board = await (await api(base)).json() as any;
  expect(board.agents.find((a: any) => a.id === 'gwen').address).toBe('luke+gwen@heddle.sh');
});
