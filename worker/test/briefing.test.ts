// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
async function ok(path: string, body?: unknown) {
  const r = await SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer test-operator', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(r.status, await r.clone().text()).toBe(200); return r.json() as Promise<any>;
}
it('agent enrollment returns the lane briefing and the board shows it; reviewers are not briefed', async () => {
  const p = `brief-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${p}`;
  await ok('/api/projects', { id: p, seed: { template: 'demo' } });
  await ok(`${base}/tasks`, { slug: 'escape', intent: 'escape test' });
  const agent = await ok(`${base}/tasks/escape/agents`, { id: 'dave', kind: 'agent', displayName: 'Dave' });
  expect(agent.briefing.hash).toMatch(/^[0-9a-f]{64}$/); expect(Array.isArray(agent.briefing.annotations)).toBe(true);
  const reviewer = await ok(`${base}/tasks/escape/agents`, { id: 'reviewer', kind: 'reviewer', displayName: 'Reviewer' });
  expect(reviewer.briefing).toBeUndefined();
  const board = await ok(base);
  const lanes = board.tasks[0].lanes;
  expect(lanes.find((l: any) => l.agent === 'dave').briefing.hash).toBe(agent.briefing.hash);
  expect(lanes.find((l: any) => l.agent === 'reviewer').briefing).toBeUndefined();
});
