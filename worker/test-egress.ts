// SPDX-License-Identifier: Apache-2.0
// Egress for a candidate-test sandbox. The container starts with no Internet; every HTTP(S)
// request reaches TestOutbound, which applies this policy. The fork read credential lives in
// the Worker and is attached here, so it never enters the sandbox running candidate code.
export interface TestGrant { remote: string; token: string }
export type TestEgress = { kind: 'deny'; reason: string } | { kind: 'forward'; authorization?: string };
export const NPM_REGISTRY = 'registry.npmjs.org';

export function decideTestEgress(url: URL, method: string, grant: TestGrant | undefined): TestEgress {
  if (url.protocol !== 'https:') return { kind: 'deny', reason: 'https only' };
  if (grant) {
    const base = new URL(grant.remote);
    if (url.origin === base.origin && (url.pathname === base.pathname || url.pathname.startsWith(`${base.pathname}/`))) {
      if (url.pathname.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack') return { kind: 'deny', reason: 'read-only' };
      return { kind: 'forward', authorization: `Bearer ${grant.token}` };
    }
  }
  if (url.hostname === NPM_REGISTRY && (method === 'GET' || method === 'HEAD')) return { kind: 'forward' };
  return { kind: 'deny', reason: 'not reachable from a candidate test' };
}
