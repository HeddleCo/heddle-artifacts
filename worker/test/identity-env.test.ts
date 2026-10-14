// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { EngineClient } from '../engine-client';
import type { Env } from '../env';
import type { Store } from '../store';

it('all engine transport commands carry the configured identity domain beside transient credentials', async () => {
  for (const domain of [undefined, 'noreply.operator.example']) {
    const calls: Array<{ command: string; env: Record<string, string> }> = [];
    const env = { ACTOR_EMAIL_DOMAIN: domain, ENGINE: { getByName: () => ({ async fetch(request: Request) {
      calls.push({ command: new URL(request.url).pathname, env: JSON.parse(request.headers.get('x-engine-env')!) });
      return Response.json({ publicKey: 'a'.repeat(64), address: 'luke+gwen@heddle.sh' });
    } }) } } as unknown as Env;
    const client = new EngineClient(env, { get: () => 0 } as unknown as Store, () => 'fixture', () => [], () => {});
    expect((await client.read('loaded', {})).address).toBe('luke+gwen@heddle.sh');
    await (client as any).transport('agent.enroll', '{}', { ARTIFACTS_WRITE_TOKEN: 'fixture-token' });
    expect(calls).toEqual([
      { command: '/loaded', env: { ACTOR_EMAIL_DOMAIN: domain ?? 'noreply.heddle.sh' } },
      { command: '/agent.enroll', env: { ACTOR_EMAIL_DOMAIN: domain ?? 'noreply.heddle.sh', ARTIFACTS_WRITE_TOKEN: 'fixture-token' } }
    ]);
  }
});
