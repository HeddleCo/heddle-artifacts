// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { HeddleEngine } from '../engine-container';
it('container wrapper passes argv/stdin/env separately and maps domain/crash exits', async () => {
  for (const [code, status] of [[0, 200], [2, 422], [1, 502]]) {
    const calls: any[] = [];
    const fake = { ctx: { container: { running: true, async setInactivityTimeout() {}, async exec(argv: string[], options: any) {
      calls.push({ argv, env: options.env, stdin: await new Response(options.stdin).text(), stderr: options.stderr });
      return { stdout: new Response('{"error":{"code":"stale","message":"changed"}}\n').body, exitCode: Promise.resolve(code) };
    } } } };
    const response = await HeddleEngine.prototype.fetch.call(fake as unknown as HeddleEngine, new Request('http://engine/decide', { method: 'POST', headers: { 'x-engine-env': JSON.stringify({ ARTIFACTS_WRITE_TOKEN: 'fixture-token' }) }, body: '{"opId":"1"}' }));
    expect(response.status).toBe(status); expect(calls).toEqual([{ argv: ['engine', 'decide'], env: { ARTIFACTS_WRITE_TOKEN: 'fixture-token' }, stdin: '{"opId":"1"}', stderr: 'ignore' }]);
  }
});
it('container snapshot exit failure aborts the streamed response', async () => {
  const fake = { ctx: { container: { running: true, async setInactivityTimeout() {}, async exec() { return { stdout: new Response('partial snapshot').body, exitCode: Promise.resolve(1) }; } } } };
  const response = await HeddleEngine.prototype.fetch.call(fake as unknown as HeddleEngine, new Request('http://engine/snapshot', { method: 'POST', body: '{}' }));
  await expect(response.arrayBuffer()).rejects.toThrow('snapshot_failed');
});
