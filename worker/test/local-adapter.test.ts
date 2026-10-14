// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { localRunner } from '../../dev/local-runner-adapter';

const input = { project: 'p', task: 't', agent: 'a', sourceSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), remote: 'http://127.0.0.1:1/x.git', readCredential: 'r' };
const env = { LOCAL_TEST_RUNNER_URL: 'http://127.0.0.1:9', LOCAL_RUNNER_SECRET: 's'.repeat(30) };
const runner = (fetchImpl: typeof fetch, e: object = env) => localRunner(e as any, fetchImpl).get('x');

it('it says it is a local runner and allows for queueing, so the coordinator labels even its own timeouts correctly', () => {
  const r = runner((async () => new Response('{}')) as any);
  expect(r.local).toBe(true); expect(r.queueAllowanceMs).toBeGreaterThan(60000);
});

it('a result passes through untouched', async () => {
  const run = { sourceSha: input.sourceSha, treeSha: input.treeSha, output: '# pass 1\n# fail 0\n', durationMs: 3, testExitCode: 0, installExitCode: 0, local: true };
  expect(await runner((async () => Response.json(run)) as any).run(input)).toEqual(run);
});

it('a runner that is unreachable, busy, shutting down or misconfigured gives a local failure result, not a thrown error the coordinator would label by guesswork', async () => {
  const cases: Array<[string, typeof fetch, object?]> = [
    ['unreachable', (async () => { throw new TypeError('fetch failed'); }) as any],
    ['busy', (async () => new Response('{"error":"busy"}', { status: 429 })) as any],
    ['shutting down', (async () => new Response('{"error":"shutting_down"}', { status: 503 })) as any],
    ['rejected', (async () => new Response('{"error":"invalid recipe"}', { status: 400 })) as any],
    ['not json', (async () => new Response('<html>', { status: 200 })) as any],
    ['unconfigured', (async () => new Response('{}')) as any, {}],
  ];
  for (const [name, fetchImpl, e] of cases) {
    const run = await runner(fetchImpl, e).run(input);
    expect(run, name).toMatchObject({ sourceSha: input.sourceSha, treeSha: input.treeSha, failure: 'sandbox', local: true, output: '' });
  }
});

it('the credential and the runner secret are sent only to the runner, in the request, and never come back in a failure result', async () => {
  let sent: { headers: Record<string, string>; body: string } | undefined;
  const run = await runner((async (_url: string, init: any) => { sent = { headers: init.headers, body: init.body }; return new Response('x', { status: 500 }); }) as any).run(input);
  expect(sent!.headers['x-runner-secret']).toBe(env.LOCAL_RUNNER_SECRET); expect(sent!.body).toContain('"readCredential":"r"');
  expect(JSON.stringify(run)).not.toContain(env.LOCAL_RUNNER_SECRET); expect(JSON.stringify(run)).not.toContain('"r"');
});
