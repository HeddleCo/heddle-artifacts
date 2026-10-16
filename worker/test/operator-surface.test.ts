// SPDX-License-Identifier: Apache-2.0
// The operator's own surface: signing in and out, a read token for plain-Git clones, and turning AI review on.
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
const op = 'test-operator';
async function api(path: string, body?: unknown, token: string | null = op) {
  const headers: Record<string, string> = {}; if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function ok(path: string, body?: unknown, token: string | null = op) {
  const response = await api(path, body, token), value = await response.json() as any;
  expect(response.status, JSON.stringify(value)).toBe(200); return value;
}
async function setup() {
  const p = `p-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${p}`;
  await ok('/api/projects', { id: p, seed: { template: 'demo' } });
  await ok(`${base}/tasks`, { slug: 'parser-escapes', intent: 'support escaped pipes' });
  const joined = await ok(`${base}/tasks/parser-escapes/agents`, { id: 'agent-0', kind: 'agent', displayName: 'Agent 0' });
  return { base, joined };
}
const login = (token: string) => SELF.fetch('https://heddle.test/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

describe('operator surface', () => {
  it('a wrong token returns to the sign-in page with a message flag, not a JSON error, and sets no cookie', async () => {
    const response = await login('wrong-token');
    expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/login?error=token');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('signing out clears the session cookie; a cross-site sign-out is refused', async () => {
    const out = await SELF.fetch('https://heddle.test/logout', { method: 'POST', redirect: 'manual' });
    expect(out.status).toBe(303); expect(out.headers.get('set-cookie')).toMatch(/^heddle_session=; .*Max-Age=0/);
    expect((await SELF.fetch('https://heddle.test/logout', { method: 'POST', redirect: 'manual', headers: { origin: 'https://other.test' } })).status).toBe(403);
    expect((await SELF.fetch('https://heddle.test/logout')).status).toBe(405);
  });
  it('the operator can issue a canonical read token; agents and visitors cannot', async () => {
    const { base, joined } = await setup();
    const issued = await ok(`${base}/read-token`, {});
    expect(typeof issued.readToken).toBe('string'); expect(issued.readToken.length).toBeGreaterThan(8);
    expect(issued.remote).toBe((await ok(base)).project.canonicalRemote); expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now());
    expect((await api(`${base}/read-token`, {}, joined.agentKey)).status).toBe(403);
    expect((await api(`${base}/read-token`, {}, null)).status).toBe(403);
  });
  it('the task view says whether AI review can run; without Workers AI, turning it on is refused with a reason', async () => {
    const { base, joined } = await setup();
    expect((await ok(`${base}/tasks/parser-escapes`)).reviewer).toEqual({ available: false, enrolled: false });
    const refused = await api(`${base}/reviewer`, {});
    expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ error: 'review_unavailable' });
    expect((await api(`${base}/reviewer`, {}, joined.agentKey)).status).toBe(403);
  });
});
