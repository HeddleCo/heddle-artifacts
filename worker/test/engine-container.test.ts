// SPDX-License-Identifier: Apache-2.0
import { it, expect, vi } from 'vitest';
import { Container } from '@cloudflare/containers';
import { HeddleEngine, ENGINE_COMMAND_MS } from '../engine-container';
it('container wrapper passes argv/stdin/env separately and maps domain/crash exits', async () => {
  for (const [code, status] of [[0, 200], [2, 422], [1, 502]]) {
    const calls: any[] = [];
    const fake = { renewActivityTimeout() {}, ctx: { container: { running: true, async setInactivityTimeout() {}, async exec(argv: string[], options: any) {
      calls.push({ argv, env: options.env, stdin: await new Response(options.stdin).text(), stderr: options.stderr });
      return { stdout: new Response('{"error":{"code":"stale","message":"changed"}}\n').body, exitCode: Promise.resolve(code) };
    } } } };
    const response = await HeddleEngine.prototype.fetch.call(fake as unknown as HeddleEngine, new Request('http://engine/decide', { method: 'POST', headers: { 'x-engine-env': JSON.stringify({ ARTIFACTS_WRITE_TOKEN: 'fixture-token' }) }, body: '{"opId":"1"}' }));
    expect(response.status).toBe(status); expect(calls).toEqual([{ argv: ['engine', 'decide'], env: { ARTIFACTS_WRITE_TOKEN: 'fixture-token' }, stdin: '{"opId":"1"}', stderr: 'ignore' }]);
  }
});
it('container snapshot exit failure aborts the streamed response', async () => {
  const fake = { renewActivityTimeout() {}, ctx: { container: { running: true, async setInactivityTimeout() {}, async exec() { return { stdout: new Response('partial snapshot').body, exitCode: Promise.resolve(1) }; } } } };
  const response = await HeddleEngine.prototype.fetch.call(fake as unknown as HeddleEngine, new Request('http://engine/snapshot', { method: 'POST', body: '{}' }));
  await expect(response.arrayBuffer()).rejects.toThrow('snapshot_failed');
});

it('custom exec renews the SDK idle deadline before awaiting the runtime call', async () => {
  let now = 295000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const timeouts: number[] = [];
  const fake: any = Object.create(Container.prototype);
  Object.assign(fake, { sleepAfter: '5m', sleepAfterMs: 300000, inflightRequests: 0,
    ctx: { container: { running: true, async setInactivityTimeout(ms: number) {
      timeouts.push(ms);
      // At the first await boundary, the SDK deadline must already be renewed.
      expect(fake.sleepAfterMs).toBe(595000);
    }, async exec() { return { stdout: null, exitCode: Promise.resolve(0) }; } } } });
  try {
    const response = await HeddleEngine.prototype.fetch.call(fake, new Request('http://engine/why', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(200); expect(timeouts).toEqual([300000]);
    now = 300001; expect(fake.isActivityExpired()).toBe(false);
    now = 595001; expect(fake.isActivityExpired()).toBe(true);
  } finally { clock.mockRestore(); }
});

it('a hung engine process is killed with its container and reported as 504 instead of wedging the caller', async () => {
  vi.useFakeTimers();
  try {
    let destroyed = 0;
    const hung = new ReadableStream({ start() {} });
    const fake = { renewActivityTimeout() {}, async destroy() { destroyed++; }, ctx: { container: { running: true, async setInactivityTimeout() {},
      async exec() { return { stdout: hung, exitCode: new Promise<number>(() => {}) }; } } } };
    const pending = HeddleEngine.prototype.fetch.call(fake as unknown as HeddleEngine, new Request('http://engine/ingest', { method: 'POST', body: '{}' }));
    await vi.advanceTimersByTimeAsync(ENGINE_COMMAND_MS + 1);
    const response = await pending;
    expect(response.status).toBe(504); expect(destroyed).toBe(1);
  } finally { vi.useRealTimers(); }
});
