// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { decideTestEgress } from '../test-egress';
const grant = { remote: 'https://acct.artifacts.cloudflare.net/git/heddle-demo/p--t--alice.git', token: 'fork-read' };
const at = (u: string, m = 'GET') => decideTestEgress(new URL(u), m, grant);
it('candidate-test egress: fork read only, npm read only, nothing else', () => {
  expect(at(`${grant.remote}/info/refs?service=git-upload-pack`)).toEqual({ kind: 'forward', authorization: 'Bearer fork-read' });
  expect(at(`${grant.remote}/git-upload-pack`, 'POST')).toEqual({ kind: 'forward', authorization: 'Bearer fork-read' });
  expect(at(`${grant.remote}/git-receive-pack`, 'POST').kind).toBe('deny');
  expect(at(`${grant.remote}/info/refs?service=git-receive-pack`).kind).toBe('deny');
  expect(at('https://acct.artifacts.cloudflare.net/git/heddle-demo/p--t--bob.git/info/refs').kind).toBe('deny');
  expect(at('https://acct.artifacts.cloudflare.net/git/heddle-demo/p--t--alice.git-evil/info/refs').kind).toBe('deny');
  expect(at('https://registry.npmjs.org/vitest')).toEqual({ kind: 'forward' });
  expect(at('https://registry.npmjs.org/-/v1/login', 'PUT').kind).toBe('deny');
  expect(at('http://registry.npmjs.org/vitest').kind).toBe('deny');
  expect(at('https://example.com/exfiltrate', 'POST').kind).toBe('deny');
  expect(decideTestEgress(new URL(`${grant.remote}/info/refs`), 'GET', undefined).kind).toBe('deny');
});
