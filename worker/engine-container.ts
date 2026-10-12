// SPDX-License-Identifier: Apache-2.0
import { Container } from '@cloudflare/containers';
export class HeddleEngine extends Container {
  // Bounded single-project demo: do not keep idle paid compute awake for hours.
  // Five minutes exceeds the per-command three-minute deadline below.
  sleepAfter = '5m';
  // The Docker CLI entrypoint exits after one command. exec needs a live instance.
  entrypoint = ['sleep', 'infinity'];
  async fetch(request: Request): Promise<Response> {
    const command = new URL(request.url).pathname.slice(1);
    if (!['restore', 'snapshot', 'init', 'task.create', 'agent.enroll', 'lane.open', 'ingest', 'candidates', 'diff', 'discuss', 'decide', 'publish', 'why', 'selftest'].includes(command)) return new Response(null, { status: 404 });
    if (!this.ctx.container) throw new Error('container_unavailable');
    // Custom exec bypasses Container.fetch, so renew the SDK's separate idle deadline.
    this.renewActivityTimeout();
    if (!this.ctx.container.running) await this.start();
    await this.ctx.container.setInactivityTimeout(5 * 60 * 1000);
    const env = JSON.parse(request.headers.get('x-engine-env') ?? '{}') as Record<string, string>;
    const process = await this.ctx.container.exec(['engine', command], { stdin: request.body ?? undefined, env, stderr: 'ignore', signal: AbortSignal.timeout(180000) });
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
    const body = stdout ? await new Response(stdout).text() : '';
    const code = await process.exitCode;
    return new Response(body, { status: code === 0 ? 200 : code === 2 ? 422 : 502, headers: { 'content-type': 'application/json' } });
  }
}
