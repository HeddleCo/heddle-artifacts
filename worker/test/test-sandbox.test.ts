// SPDX-License-Identifier: Apache-2.0
import { it, expect, vi } from 'vitest';
import { Files } from '@cloudflare/sandbox';
import { CandidateTestSandbox } from '../test-sandbox';
import { isolatedTestResult } from '../../engine/lib/isolated-tests.mjs';
const input = { project: 'p', task: 't', agent: 'alice', sourceSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), remote: 'https://artifacts.example/p--t--alice.git', readCredential: 'fork-read-fixture' };
function fixture(options: { installExit?: number; testExit?: number; output?: string; tree?: string; hang?: boolean; cleanupFails?: boolean } = {}) {
  const calls: any[] = [], starts: any[] = [], storage = new Map(); let destroyed = 0;
  const fake: any = { ctx: { async blockConcurrencyWhile(fn: () => unknown) { return fn(); }, storage: { async get(k: string) { return storage.get(k); }, async put(k: string, v: unknown) { storage.set(k, v); }, async setAlarm() {}, async deleteAlarm() {} },
    container: { images: { tests: 'image-tests' }, start(config: any) { starts.push(config); }, async setInactivityTimeout(ms: number) { expect(ms).toBe(30000); },
      async destroy() { destroyed++; if (options.cleanupFails) throw new Error('cleanup'); },
      async exec(argv: string[], config: any) {
        calls.push({ argv, config });
        const cmd = argv.slice(3); let output = '', code = 0;
        if (cmd[0] === 'git' && cmd[1] === 'rev-parse') output = `${cmd[2] === 'HEAD' ? input.sourceSha : options.tree ?? input.treeSha}\n`;
        if (cmd[0] === 'npm' && cmd[1] === 'ci') code = options.installExit ?? 0;
        if (cmd[0] === 'npm' && cmd[1] === 'test') {
          output = options.output ?? '# pass 18\n# fail 0\n'; code = options.testExit ?? 0;
          if (options.hang) return { stdout: new ReadableStream(), exitCode: new Promise(() => {}) };
        }
        return { stdout: new Response(output).body, exitCode: Promise.resolve(code) };
      }
    } } };
  return { fake, calls, starts, destroyed: () => destroyed };
}
it('real Sandbox adapter pins SHA/tree, runs npm ci without scripts then test, forwards only fork read auth and destroys once', async () => {
  const mkdir = vi.spyOn(Files.prototype, 'mkdir').mockResolvedValue();
  try {
    const f = fixture(), run = await CandidateTestSandbox.prototype.run.call(f.fake, input);
    expect(isolatedTestResult(run)).toMatchObject({ status: 'pass', passed: 18, provenance: 'isolated sandbox' });
    expect(f.starts).toEqual([undefined]);
    const commands = f.calls.map(c => c.argv.slice(3));
    expect(commands).toContainEqual(['git', 'fetch', '--no-tags', '--depth=1', '--', input.remote, input.sourceSha]);
    expect(commands.slice(-2)).toEqual([['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['npm', 'test']]);
    for (const call of f.calls) {
      expect(call.argv.slice(0, 2)).toEqual(['timeout', '--kill-after=1']); expect(Number(call.argv[2])).toBeLessThanOrEqual(180);
      const env = call.config.env ?? {};
      if (call.argv[4] === 'fetch') expect(env).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${input.remote}.extraHeader`, GIT_CONFIG_VALUE_0: 'Authorization: Bearer fork-read-fixture', GIT_TERMINAL_PROMPT: '0' });
      else expect(JSON.stringify(env)).not.toContain(input.readCredential);
      expect(JSON.stringify(env)).not.toMatch(/OPERATOR_TOKEN|ARTIFACTS_WRITE|PRIVATE_KEY|CF_EVENTS_API/);
    }
    expect(f.destroyed()).toBe(1);
    expect((await CandidateTestSandbox.prototype.run.call(f.fake, input)).failure).toBe('sandbox');
    expect(f.starts).toHaveLength(1);
  } finally { mkdir.mockRestore(); }
});
it('checkout mismatch, install failure, timeout exit, output overflow and failed cleanup never become pass', async () => {
  const mkdir = vi.spyOn(Files.prototype, 'mkdir').mockResolvedValue();
  try {
    for (const options of [{ tree: 'c'.repeat(40) }, { installExit: 1 }, { testExit: 124 }, { output: 'x'.repeat(65537) }, { cleanupFails: true }]) {
      const f = fixture(options), run = await CandidateTestSandbox.prototype.run.call(f.fake, input);
      expect(isolatedTestResult(run).status).toBe('error'); expect(f.destroyed()).toBeGreaterThanOrEqual(1);
      if ('tree' in options || 'installExit' in options) expect(f.calls.some(c => c.argv.slice(3).join(' ') === 'npm test')).toBe(false);
    }
  } finally { mkdir.mockRestore(); }
});
it('wall clock deadline destroys even a stuck SDK stream and returns error', async () => {
  const mkdir = vi.spyOn(Files.prototype, 'mkdir').mockResolvedValue(); vi.useFakeTimers();
  try {
    const f = fixture({ hang: true }), pending = CandidateTestSandbox.prototype.run.call(f.fake, input);
    await vi.advanceTimersByTimeAsync(180000);
    const run = await pending; expect(run.failure).toBe('timeout'); expect(isolatedTestResult(run).status).toBe('error');
    expect(f.destroyed()).toBeGreaterThanOrEqual(1);
  } finally { vi.useRealTimers(); mkdir.mockRestore(); }
});
