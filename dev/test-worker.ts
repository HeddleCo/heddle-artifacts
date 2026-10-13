// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from 'cloudflare:workers';
import { fetchApi } from '../worker/api';
import { queue } from '../worker/events';
import { emptyState, executeFixture } from './stub-engine.mjs';
import { ProjectDO as Coordinator } from '../worker/project-do';
import { memoryArtifacts } from './memory-artifacts';
import type { Env } from '../worker/env';
import { fakeTestRunner } from './fake-test-runner';
export class ProjectDO extends Coordinator {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env.DEV === '1' ? { ...env, TEST_RUNNER: fakeTestRunner } : { ...env, TEST_RUNNER: fakeTestRunner, ARTIFACTS: memoryArtifacts, REVIEW: { async review(input) { return { summary: 'Fixture review', perCandidate: input.candidates.map(c => ({ agent: c.agent, verdict: 'approve' as const, notes: 'fixture' })), model: 'stub' }; } } }); }
}
export class StubEngine extends DurableObject {
  state = emptyState();
  calls: Array<{ command: string; input: any; hasCanonicalRead?: boolean }> = [];
  delay: { command: string; ms: number } | undefined;
  isolatedFixture = false;
  async delayNext(command: string, ms: number) { this.delay = { command, ms }; }
  isolateUnreviewed() { this.isolatedFixture = true; }
  // Combined-check fixture hooks survive snapshot restores, like the isolation flag above.
  combinedFixture: { conflictsWithMain: string[]; containsMain: string[] } = { conflictsWithMain: [], containsMain: [] };
  conflictWithMain(agents: string[]) { this.combinedFixture.conflictsWithMain = agents; }
  markContainsMain(shas: string[]) { this.combinedFixture.containsMain = shas; }
  failures: { command: string; count: number; after: boolean; body: string } | undefined;
  async failNext(command: string, count = 1, after = true, body = 'crash fixture') { this.failures = { command, count, after, body }; }
  stats() { return { calls: this.calls, state: this.state }; }
  // A container restart: no state and no restore token.
  loseDisk() { this.state = emptyState(); this.loadedToken = null; }
  loadedToken: string | null = null;
  async fetch(request: Request): Promise<Response> {
    const command = new URL(request.url).pathname.slice(1);
    if (command === 'restore') { this.state = JSON.parse(await request.text()); this.calls.push({ command, input: {} }); this.loadedToken = crypto.randomUUID(); return Response.json({ generation: this.state.generation, loaded: this.loadedToken }); }
    if (command === 'loaded') { this.calls.push({ command, input: {} }); return Response.json({ loaded: this.loadedToken }); }
    if (command === 'snapshot') return new Response(JSON.stringify(this.state));
    const input = await request.json();
    if (this.isolatedFixture) this.state.isolateUnreviewed = true;
    Object.assign(this.state, this.combinedFixture);
    const env = JSON.parse(request.headers.get('x-engine-env') ?? '{}');
    const reads = JSON.parse(env.ARTIFACTS_READ_TOKENS ?? '{}');
    this.calls.push({ command, input, hasCanonicalRead: command === 'publish' ? typeof reads[input.canonical.remote] === 'string' : undefined });
    if (this.delay?.command === command) { const ms = this.delay.ms; this.delay = undefined; await new Promise(r => setTimeout(r, ms)); }
    if (this.failures?.command === command && this.failures.count > 0) {
      this.failures.count--; if (this.failures.after) executeFixture(this.state, command, input);
      this.state = emptyState(); this.loadedToken = null; return new Response(this.failures.body, { status: 502 });
    }
    const result = executeFixture(this.state, command, input);
    return Response.json(result, { status: result.error ? 422 : 200 });
  }
}
export default { fetch: fetchApi, queue };
