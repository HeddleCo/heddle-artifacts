// SPDX-License-Identifier: Apache-2.0
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { decideTestEgress, type TestGrant } from './test-egress';
import { Files } from '@cloudflare/sandbox';
import { TEST_OUTPUT_BYTES } from '../engine/lib/isolated-tests.mjs';
import { DEFAULT_TEST_RECIPE } from './test-recipe';
import type { SandboxInput, SandboxRun, TestRunner } from './isolated-tests';

const CA_PATH = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
// Intercepted HTTPS is re-signed by the platform CA; git and npm must trust it.
export const TRUST_ENV = { GIT_SSL_CAINFO: CA_PATH, NODE_EXTRA_CA_CERTS: CA_PATH, SSL_CERT_FILE: CA_PATH, npm_config_cafile: CA_PATH, GIT_TERMINAL_PROMPT: '0' };

export function startTestContainer(container: Container): void {
  // With the default policy, image and size come from Wrangler. The image has
  // no secrets and sleeps indefinitely; no Worker environment enters start().
  // No direct Internet: all egress goes through TestOutbound.
  container.start({ enableInternet: false });
}

/** Runs in the trusted Worker: attaches the fork read credential outside the sandbox. */
export class TestOutbound extends WorkerEntrypoint<unknown, { grant?: TestGrant }> {
  async fetch(request: Request): Promise<Response> {
    const decision = decideTestEgress(new URL(request.url), request.method, this.ctx.props.grant);
    if (decision.kind === 'deny') return new Response(`${decision.reason}\n`, { status: 403 });
    const headers = new Headers(request.headers); headers.delete('authorization');
    if (decision.authorization) headers.set('authorization', decision.authorization);
    return fetch(new Request(request, { headers }));
  }
}

// This DO lives in the trusted Worker. Only the explicit argv/env below enter
// its separate microVM; Worker bindings and secrets never enter the container.
export class CandidateTestSandbox extends DurableObject implements TestRunner {
  async destroy(): Promise<void> { await this.ctx.container?.destroy(); }
  async run(input: SandboxInput): Promise<SandboxRun> {
    const start = Date.now(), container = this.ctx.container, recipe = input.recipe ?? DEFAULT_TEST_RECIPE, budgetMs = recipe.budgetMs;
    const result: SandboxRun = { sourceSha: input.sourceSha, treeSha: input.treeSha, output: '', durationMs: 0, ...(input.recipe ? { budgetMs } : {}) };
    if (!container) return { ...result, failure: 'sandbox' };
    // Never restart an already used candidate instance, including after eviction.
    const claimed = await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('used')) return false;
      await this.ctx.storage.put('used', true); return true;
    });
    if (!claimed) return { ...result, failure: 'sandbox' };
    await this.ctx.storage.setAlarm(start + budgetMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let bytes = 0;
    const exec = async (argv: string[], options: ContainerExecOptions = {}) => {
      const remaining = Math.max(1, Math.ceil((budgetMs - (Date.now() - start)) / 1000));
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
        const outbound = (this.ctx as unknown as { exports: { TestOutbound(o: { props: { grant: TestGrant } }): Fetcher } }).exports
          .TestOutbound({ props: { grant: { remote: input.remote, token: input.readCredential } } });
        await container.interceptAllOutboundHttp(outbound);
        await container.interceptOutboundHttps('*', outbound);
        await container.setInactivityTimeout(30000);
        await new Files(container).mkdir('/workspace/candidate', { recursive: true });
        const cwd = '/workspace/candidate';
        if ((await exec(['git', 'init', cwd])).code !== 0) throw new Error('init');
        // Fetch only the recorded commit. TestOutbound adds the fork read credential outside the
        // container, so no credential is ever visible to the candidate code that runs next.
        if ((await exec(['git', 'fetch', '--no-tags', '--depth=1', '--', input.remote, input.sourceSha], { cwd, env: TRUST_ENV })).code !== 0) throw new Error('fetch');
        if ((await exec(['git', 'checkout', '--detach', input.sourceSha], { cwd })).code !== 0) throw new Error('checkout');
        const sha = await exec(['git', 'rev-parse', 'HEAD'], { cwd });
        const tree = await exec(['git', 'rev-parse', 'HEAD^{tree}'], { cwd });
        if (sha.code || tree.code || sha.output.trim() !== input.sourceSha || tree.output.trim() !== input.treeSha) { result.failure = 'checkout'; throw new Error('tree'); }
        const env = { CI: '1', NO_COLOR: '1', HOME: '/tmp', NPM_CONFIG_UPDATE_NOTIFIER: 'false', ...TRUST_ENV };
        // Setup steps (install, generated files) stop at the first failure; only the test step's output is kept.
        result.installExitCode = 0;
        for (const step of recipe.setup) {
          result.installExitCode = (await exec(step, { cwd, env })).code;
          if (result.installExitCode !== 0) return;
        }
        const test = await exec(recipe.test, { cwd, env });
        result.testExitCode = test.code; result.output = test.output;
      };
      await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => { result.failure = 'timeout'; void container.destroy().catch(() => {}); reject(new Error('timeout')); }, Math.max(1, budgetMs - (Date.now() - start))); })]);
    } catch (error) {
      result.failure ||= 'sandbox';
      // Step codes only (init/fetch/checkout/tree/remote/sha/timeout/output or a runtime error name); no output, URLs or credentials.
      console.error({ event: 'candidate_test.failed', step: error instanceof Error ? (/^[a-z]{2,10}$/.test(error.message) ? error.message : error.name) : 'unknown', failure: result.failure });
    }
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
