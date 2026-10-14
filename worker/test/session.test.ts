// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

const get = (headers: Record<string, string> = {}) => SELF.fetch('https://heddle.test/api/session', { headers });

it('an anonymous visitor is not an operator, so the UI can hide the create forms from judges', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ operator: false, demo: 'demo' });
  expect(response.headers.get('cache-control')).toBe('no-store');
});

it('a valid operator bearer or session cookie is an operator', async () => {
  expect(await (await get({ authorization: 'Bearer test-operator' })).json()).toEqual({ operator: true, demo: 'demo' });
  expect(await (await get({ cookie: 'heddle_session=test-operator' })).json()).toEqual({ operator: true, demo: 'demo' });
});

it('a wrong or near-miss token is not an operator', async () => {
  const nearMisses: Array<Record<string, string>> = [{ authorization: 'Bearer test-operato' }, { authorization: 'Bearer ' }, { cookie: 'heddle_session=wrong' }, { cookie: 'other=test-operator' }];
  for (const headers of nearMisses)
    expect(await (await get(headers)).json()).toEqual({ operator: false, demo: 'demo' });
});

it('the answer is the operator flag and the public demo project name, and never echoes the credential', async () => {
  const text = await (await get({ authorization: 'Bearer test-operator' })).text();
  expect(text).not.toContain('test-operator');
  expect(Object.keys(JSON.parse(text)).sort()).toEqual(['demo', 'operator']);
});

it('only GET is accepted', async () => {
  const response = await SELF.fetch('https://heddle.test/api/session', { method: 'POST', headers: { authorization: 'Bearer test-operator', 'content-type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(405);
});

it('with no public demo project configured, the demo field is absent', async () => {
  const { env } = await import('cloudflare:test');
  const saved = (env as { DEMO_PROJECT?: string }).DEMO_PROJECT;
  (env as { DEMO_PROJECT?: string }).DEMO_PROJECT = undefined;
  try { expect(await (await get()).json()).toEqual({ operator: false }); } finally { (env as { DEMO_PROJECT?: string }).DEMO_PROJECT = saved; }
});
