// SPDX-License-Identifier: Apache-2.0
import { Container } from '@cloudflare/containers';
import { deadline, DeadlineError } from './deadline';
export const ENGINE_COMMAND_MS = 180000;
export const ENGINE_START_MS = 120000;
/** Commands the container will exec; must cover every command engine/engine.mjs accepts (a test checks). */
export const ENGINE_COMMANDS = ['restore', 'loaded', 'snapshot', 'init', 'task.create', 'agent.enroll', 'lane.open', 'ingest', 'tests.record', 'combine', 'candidates', 'diff', 'discuss', 'decide', 'publish', 'why', 'decision.validate', 'selftest'];
export class HeddleEngine extends Container {
  // Bounded single-project demo: do not keep idle paid compute awake for hours.
  // Five minutes exceeds the per-command three-minute deadline below.
  sleepAfter = '5m';
  // The Docker CLI entrypoint exits after one command. exec needs a live instance.
  entrypoint = ['sleep', 'infinity'];
  async fetch(request: Request): Promise<Response> {
    const command = new URL(request.url).pathname.slice(1);
    if (!ENGINE_COMMANDS.includes(command)) return new Response(null, { status: 404 });
    if (!this.ctx.container) throw new Error('container_unavailable');
    // Custom exec bypasses Container.fetch, so renew the SDK's separate idle deadline.
    this.renewActivityTimeout();
    // Bound the start too: every deadline lives here, beside the container, so callers never wait forever.
    if (!this.ctx.container.running) {
      try { await deadline(this.start(), ENGINE_START_MS, 'engine_start_timeout'); }
      catch (error) { if (!(error instanceof DeadlineError)) throw error; await this.destroy().catch(() => {}); return new Response(null, { status: 504 }); }
    }
    await this.ctx.container.setInactivityTimeout(5 * 60 * 1000);
    const env = JSON.parse(request.headers.get('x-engine-env') ?? '{}') as Record<string, string>;
    const process = await this.ctx.container.exec(['engine', command], { stdin: request.body ?? undefined, env, stderr: 'ignore', signal: AbortSignal.timeout(ENGINE_COMMAND_MS) });
    // Preserve streaming for snapshots; the stream fails if the process exits nonzero.
    const stdout = process.stdout;
    if (command === 'snapshot' && stdout) {
      const reader = stdout.getReader();
      return new Response(new ReadableStream({
        async pull(controller) {
          try { const { done, value } = await reader.read(); if (done) { if (await process.exitCode !== 0) throw new Error('snapshot_failed'); controller.close(); } else controller.enqueue(value); } catch (e) { controller.error(e); }
        }, cancel: reason => reader.cancel(reason)
      }), { headers: { 'content-type': 'application/zstd' } });
    }
    // The exec signal bounds process start only; bound reading its output and exit too. A process
    // that outlives the deadline is killed with its container, and the journal retries from R2 state.
    try {
      const [body, code] = await deadline(Promise.all([stdout ? new Response(stdout).text() : Promise.resolve(''), process.exitCode]), ENGINE_COMMAND_MS, 'engine_timeout');
      return new Response(body, { status: code === 0 ? 200 : code === 2 ? 422 : 502, headers: { 'content-type': 'application/json' } });
    } catch (error) {
      if (!(error instanceof DeadlineError)) throw error;
      await this.destroy().catch(() => {});
      return new Response(null, { status: 504 });
    }
  }
}
