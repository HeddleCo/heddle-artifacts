// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from 'cloudflare:workers';
import { Files } from '@cloudflare/sandbox';
import { TEST_BUDGET_MS, TEST_OUTPUT_BYTES } from '../engine/lib/isolated-tests.mjs';
import type { SandboxInput, SandboxRun, TestRunner } from './isolated-tests';

export function startTestContainer(container: Container): void {
  // With the default policy, image and size come from Wrangler. The image has
  // no secrets and sleeps indefinitely; no Worker environment enters start().
  container.start();
}

// This DO lives in the trusted Worker. Only the explicit argv/env below enter
// its separate microVM; Worker bindings and secrets never enter the container.
export class CandidateTestSandbox extends DurableObject implements TestRunner {
  async destroy(): Promise<void> { await this.ctx.container?.destroy(); }
  async run(input: SandboxInput): Promise<SandboxRun> {
    const start = Date.now(), container = this.ctx.container;
    const result: SandboxRun = { sourceSha: input.sourceSha, treeSha: input.treeSha, output: '', durationMs: 0 };
    if (!container) return { ...result, failure: 'sandbox' };
    // Never restart an already used candidate instance, including after eviction.
    const claimed = await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('used')) return false;
      await this.ctx.storage.put('used', true); return true;
    });
    if (!claimed) return { ...result, failure: 'sandbox' };
    await this.ctx.storage.setAlarm(start + TEST_BUDGET_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let bytes = 0;
    const exec = async (argv: string[], options: ContainerExecOptions = {}) => {
      const remaining = Math.max(1, Math.ceil((TEST_BUDGET_MS - (Date.now() - start)) / 1000));
      const proc = await container.exec(['timeout', '--kill-after=1', String(remaining), ...argv], { ...options, stderr: 'combined' });
      // Teardown/output overflow may throw before the exit is awaited below.
      // Consume a later runtime rejection without losing the original failure.
      void proc.exitCode.catch(() => {});
      const reader = proc.stdout?.getReader(); let output = '';
      if (reader) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > TEST_OUTPUT_BYTES) { result.failure = 'output'; await container.destroy(); throw new Error('output'); }
        output += new TextDecoder().decode(value, { stream: true });
      }
      const code = await proc.exitCode;
      if (code === 124 || code === 137) { result.failure = 'timeout'; throw new Error('timeout'); }
      return { code, output };
    };
    try {
      const work = async () => {
        if (!/^[a-f0-9]{40}$/.test(input.sourceSha) || !/^[a-f0-9]{40}$/.test(input.treeSha)) throw new Error('sha');
        const remote = new URL(input.remote);
        if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new Error('remote');
        startTestContainer(container);
        await container.setInactivityTimeout(30000);
        await new Files(container).mkdir('/workspace/candidate', { recursive: true });
        const cwd = '/workspace/candidate';
        if ((await exec(['git', 'init', cwd])).code !== 0) throw new Error('init');
        // Fetch only the recorded commit, with one fork read credential. The
        // credential is process-local, never saved in .git/config or a URL.
        const auth = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${input.remote}.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${input.readCredential}`, GIT_TERMINAL_PROMPT: '0' };
        if ((await exec(['git', 'fetch', '--no-tags', '--depth=1', '--', input.remote, input.sourceSha], { cwd, env: auth })).code !== 0) throw new Error('fetch');
        if ((await exec(['git', 'checkout', '--detach', input.sourceSha], { cwd })).code !== 0) throw new Error('checkout');
        const sha = await exec(['git', 'rev-parse', 'HEAD'], { cwd });
        const tree = await exec(['git', 'rev-parse', 'HEAD^{tree}'], { cwd });
        if (sha.code || tree.code || sha.output.trim() !== input.sourceSha || tree.output.trim() !== input.treeSha) { result.failure = 'checkout'; throw new Error('tree'); }
        const env = { CI: '1', NO_COLOR: '1', HOME: '/tmp', NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
        result.installExitCode = (await exec(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, env })).code;
        if (result.installExitCode !== 0) return;
        const test = await exec(['npm', 'test'], { cwd, env });
        result.testExitCode = test.code; result.output = test.output;
      };
      await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => { result.failure = 'timeout'; void container.destroy().catch(() => {}); reject(new Error('timeout')); }, Math.max(1, TEST_BUDGET_MS - (Date.now() - start))); })]);
    } catch { result.failure ||= 'sandbox'; }
    finally {
      if (timer) clearTimeout(timer);
      try { await container.destroy(); await this.ctx.storage.deleteAlarm(); }
      catch { result.failure = 'sandbox'; await this.ctx.storage.setAlarm(Date.now() + 1000); }
      result.durationMs = Date.now() - start;
    }
    return result;
  }
  async alarm(): Promise<void> {
    try { await this.destroy(); await this.ctx.storage.deleteAlarm(); }
    catch { await this.ctx.storage.setAlarm(Date.now() + 1000); }
  }
}
