// SPDX-License-Identifier: Apache-2.0
import { it, expect, vi } from 'vitest';
import { Files } from '@cloudflare/sandbox';
import { CandidateTestSandbox } from '../test-sandbox';
import { isolatedTestResult } from '../../engine/lib/isolated-tests.mjs';
import { parseTestRecipe } from '../test-recipe';
const input = { project: 'p', task: 't', agent: 'alice', sourceSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), remote: 'https://artifacts.example/p--t--alice.git', readCredential: 'fork-read-fixture' };
function fixture(options: { installExit?: number; testExit?: number; output?: string; tree?: string; hang?: boolean; cleanupFails?: boolean; stepExit?: Record<string, number> } = {}) {
  const calls: any[] = [], starts: any[] = [], intercepts: any[] = [], grants: any[] = [], storage = new Map(); let destroyed = 0;
  const fake: any = { ctx: { async blockConcurrencyWhile(fn: () => unknown) { return fn(); }, storage: { async get(k: string) { return storage.get(k); }, async put(k: string, v: unknown) { storage.set(k, v); }, async setAlarm() {}, async deleteAlarm() {} },
    exports: { TestOutbound(o: any) { grants.push(o.props.grant); return { fetcher: 'test-outbound' }; } },
    container: { images: { tests: 'image-tests' }, start(config: any) { starts.push(config); },
      async interceptAllOutboundHttp(f: any) { intercepts.push(['http', f]); }, async interceptOutboundHttps(target: string, f: any) { intercepts.push([target, f]); }, async setInactivityTimeout(ms: number) { expect(ms).toBe(30000); },
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
        code = options.stepExit?.[cmd.join(' ')] ?? code;
        return { stdout: new Response(output).body, exitCode: Promise.resolve(code) };
      }
    } } };
  return { fake, calls, starts, intercepts, grants, destroyed: () => destroyed };
}
it('real Sandbox adapter pins SHA/tree, runs npm ci without scripts then test, forwards only fork read auth and destroys once', async () => {
  const mkdir = vi.spyOn(Files.prototype, 'mkdir').mockResolvedValue();
  try {
    const f = fixture(), run = await CandidateTestSandbox.prototype.run.call(f.fake, input);
    expect(isolatedTestResult(run)).toMatchObject({ status: 'pass', passed: 18, provenance: 'isolated sandbox' });
    expect(f.starts).toEqual([{ enableInternet: false }]);
    expect(f.intercepts).toEqual([['http', { fetcher: 'test-outbound' }], ['*', { fetcher: 'test-outbound' }]]);
    // The read credential reaches only the Worker-side egress handler, never a container process.
    expect(f.grants).toEqual([{ remote: input.remote, token: input.readCredential }]);
    const commands = f.calls.map(c => c.argv.slice(3));
    expect(commands).toContainEqual(['git', 'fetch', '--no-tags', '--depth=1', '--', input.remote, input.sourceSha]);
    expect(commands.slice(-2)).toEqual([['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['npm', 'test']]);
    for (const call of f.calls) {
      expect(call.argv.slice(0, 2)).toEqual(['timeout', '--kill-after=1']); expect(Number(call.argv[2])).toBeLessThanOrEqual(180);
      const env = call.config.env ?? {};
      expect(JSON.stringify(call)).not.toContain(input.readCredential);
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
it('a project recipe runs its setup steps in order, then its test step, within its own budget', async () => {
  const mkdir = vi.spyOn(Files.prototype, 'mkdir').mockResolvedValue();
  const install = ['npx', '--yes', 'pnpm@10', 'install', '--frozen-lockfile', '--ignore-scripts'], sync = ['npx', '--yes', 'pnpm@10', '--filter', 'site', 'exec', 'svelte-kit', 'sync'];
  const recipe = parseTestRecipe({ setup: [install, sync], test: ['npm', 'test'], budgetSeconds: 420 });
  try {
    const f = fixture(), run = await CandidateTestSandbox.prototype.run.call(f.fake, { ...input, recipe });
    expect(f.calls.map(c => c.argv.slice(3)).slice(-3)).toEqual([install, sync, ['npm', 'test']]);
    // Every step runs under the recipe's budget, not the default 180 seconds.
    expect(Math.max(...f.calls.map(c => Number(c.argv[2])))).toBeGreaterThan(180);
    for (const call of f.calls) expect(Number(call.argv[2])).toBeLessThanOrEqual(420);
    expect(run.budgetMs).toBe(420000);
    expect(isolatedTestResult({ ...run, durationMs: 300000 })).toMatchObject({ status: 'pass', passed: 18 });
    // A failing setup step stops the run before the test step, and never becomes a pass.
    const g = fixture({ stepExit: { [sync.join(' ')]: 1 } }), failed = await CandidateTestSandbox.prototype.run.call(g.fake, { ...input, recipe });
    expect(g.calls.some(c => c.argv.slice(3).join(' ') === 'npm test')).toBe(false);
    expect(failed.installExitCode).toBe(1); expect(isolatedTestResult(failed)).toMatchObject({ status: 'error', summary: 'Isolated sandbox dependency install failed' });
  } finally { mkdir.mockRestore(); }
});
it('a recipe deadline is the recipe budget', async () => {
  const mkdir = vi.spyOn(Files.prototype, 'mkdir').mockResolvedValue(); vi.useFakeTimers();
  try {
    const recipe = parseTestRecipe({ test: ['npm', 'test'], budgetSeconds: 300 });
    const f = fixture({ hang: true }), pending = CandidateTestSandbox.prototype.run.call(f.fake, { ...input, recipe });
    let settled = false; void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(200000); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100000);
    const run = await pending; expect(run.failure).toBe('timeout'); expect(isolatedTestResult(run)).toMatchObject({ status: 'error', summary: 'Isolated sandbox exceeded 300 seconds' });
  } finally { vi.useRealTimers(); mkdir.mockRestore(); }
});
it('recipes are argv for package managers only, with a bounded budget', () => {
  expect(parseTestRecipe({ test: ['npm', 'test'] })).toEqual({ setup: [], test: ['npm', 'test'], budgetMs: 180000 });
  for (const bad of [null, [], { test: ['sh', '-c', 'npm test'] }, { test: ['npm', 'test\nrm -rf /'] }, { test: [] }, { test: ['npm', 'test'], budgetSeconds: 10 },
    { test: ['npm', 'test'], budgetSeconds: 601 }, { test: ['npm', 'test'], budgetSeconds: 200.5 }, { test: ['npm', 'test'], extra: true },
    { setup: Array(7).fill(['npm', 'ci']), test: ['npm', 'test'] }, { setup: [['bash', 'x']], test: ['npm', 'test'] }]) {
    expect(() => parseTestRecipe(bad)).toThrow(expect.objectContaining({ status: 400, code: 'invalid_test_recipe' }));
  }
});
