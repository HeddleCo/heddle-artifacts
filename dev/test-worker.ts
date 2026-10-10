// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from 'cloudflare:workers';
import { fetchApi } from '../worker/api';
import { queue } from '../worker/events';
import { emptyState, executeFixture } from './stub-engine.mjs';
import { ProjectDO as Coordinator } from '../worker/project-do';
import { memoryArtifacts } from './memory-artifacts';
import type { Env } from '../worker/env';
export class ProjectDO extends Coordinator {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env.DEV === '1' ? env : { ...env, ARTIFACTS: memoryArtifacts, REVIEW: { async review(input) { return { summary: 'Fixture review', perCandidate: input.candidates.map(c => ({ agent: c.agent, verdict: 'approve' as const, notes: 'fixture' })), model: 'stub' }; } } }); }
}
export class StubEngine extends DurableObject {
  state = emptyState();
  calls: Array<{ command: string; input: any }> = [];
  delay: { command: string; ms: number } | undefined;
  async delayNext(command: string, ms: number) { this.delay = { command, ms }; }
  failures: { command: string; count: number; after: boolean } | undefined;
  async failNext(command: string, count = 1, after = true) { this.failures = { command, count, after }; }
  stats() { return { calls: this.calls, state: this.state }; }
  loseDisk() { this.state = emptyState(); }
  async fetch(request: Request): Promise<Response> {
    const command = new URL(request.url).pathname.slice(1);
    if (command === 'restore') { this.state = JSON.parse(await request.text()); this.calls.push({ command, input: {} }); return Response.json({ generation: this.state.generation }); }
    if (command === 'snapshot') return new Response(JSON.stringify(this.state));
    const input = await request.json(); this.calls.push({ command, input });
    if (this.delay?.command === command) { const ms = this.delay.ms; this.delay = undefined; await new Promise(r => setTimeout(r, ms)); }
    if (this.failures?.command === command && this.failures.count > 0) {
      this.failures.count--; if (this.failures.after) executeFixture(this.state, command, input);
      this.state = emptyState(); return new Response('crash fixture', { status: 502 });
    }
    const result = executeFixture(this.state, command, input);
    return Response.json(result, { status: result.error ? 422 : 200 });
  }
}
export default { fetch: fetchApi, queue };
