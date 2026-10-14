// SPDX-License-Identifier: Apache-2.0
import { createReviewer } from 'heddle-reviewer';
import { DurableObject } from 'cloudflare:workers';
import type { Agent, Candidate, Decision, FeedEvent, Lane, Review, Turn } from '../contracts/types';
import type { Env } from './env';
import { artifacts, existingRepository, forkName, setupScript, subscribeFork } from './artifacts';
import { bodyText, checkOrigin, credential, digest, email, HttpError, jsonBody, operator, randomKey, responseError, slug, text } from './auth';
import { Store } from './store';
import { EngineClient } from './engine-client';
import { DemoCredentials } from './credentials';
import { sandboxId, type SandboxRun, type TestRunner } from './isolated-tests';
import { TEST_BUDGET_MS, TEST_OUTPUT_BYTES } from '../engine/lib/isolated-tests.mjs';
import { parseTestRecipe, type TestRecipe } from './test-recipe';
// A failed ingest is retried twice, a minute and then two minutes later, before the push counts as failed.
export const PUSH_RETRIES = 2, PUSH_RETRY_MS = 60000;
import { decisionOptions, DecisionInputError } from '../engine/lib/decision-anchor.mjs';
import { combinedRefusal } from '../engine/lib/combined-rule.mjs';

type Task = { slug: string; intent: string; thread: string; baseSha: string; status: 'open' | 'decided' };
// A lane that never pushes must not hold up review of the others forever.
export const REVIEW_WAIT_MS = 5 * 60 * 1000;
// A combined job tests the candidate merged with main: sourceSha/treeSha are the combined commit in
// the canonical repository; `combined` names the candidate push and main it was merged from.
type SandboxJob = { id: string; task: string; agent: string; sourceSha: string; treeSha: string; status: 'queued'|'running'|'observed'|'done'; startedAt?: number; run?: SandboxRun;
  combined?: { candidateSha: string; mainSha: string } };
export class ProjectDO extends DurableObject<Env> {
  store: Store;
  engine: EngineClient;
  credentials: DemoCredentials;
  private credentialRecovery = true;
  private draining: Promise<void> | undefined;
  private isolated = new Map<string, Promise<void>>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, REVIEW: env.REVIEW ?? { review: createReviewer(env) } }); this.store = new Store(ctx.storage);
    this.credentials = new DemoCredentials(env, this.store);
    this.engine = new EngineClient(env, this.store, () => this.store.get('meta', 'project')?.id ?? '', this.apply.bind(this), this.emit.bind(this), this.credentials);
  }
  // Internal RPC registry: event routing never trusts task/agent fields in event input.
  registerFork(fork: string, project: string) { this.store.put('meta', `fork:${fork}`, project); }
  lookupFork(fork: string): string | undefined { return this.store.get('meta', `fork:${fork}`); }
  private emit(event: FeedEvent) {
    this.expireAccess();
    for (const socket of this.ctx.getWebSockets()) { if (!this.feedAuthorized(socket)) continue; try { socket.send(JSON.stringify(event)); } catch { socket.close(1011, 'feed unavailable'); } }
  }
  private apply(command: string, input: any, result: any, context: any): FeedEvent[] {
    const events: FeedEvent[] = [];
    if (command === 'init') this.store.put('meta', 'mainSha', result.mainSha);
    if (command === 'task.create') this.store.put('tasks', input.task, { slug: input.task, intent: input.intent, ...result, status: 'open' });
    if (command === 'agent.enroll') this.store.put('agents', input.agent.id, { ...this.store.get<Agent>('agents', input.agent.id), ...input.agent, ...result });
    if (command === 'lane.open') {
      const lane = this.store.get<Lane>('lanes', `${input.task}/${input.agent}`)!;
      this.store.put('lanes', `${input.task}/${input.agent}`, { ...lane, laneThread: result.laneThread, status: 'active', ...(result.briefing ? { briefing: result.briefing } : {}), ...(input.brief === false ? { unbriefed: true } : {}) });
    }
    if (command === 'ingest') {
      if (!Array.isArray(result.results) || result.results.length !== input.items.length) throw new Error('incomplete_ingest_result');
      const consumed = new Set();
      for (const item of result.results) {
        const laneId = `${item.task}/${item.agent}`, lane = this.store.get<Lane>('lanes', laneId);
        const original = input.items.find((i: any) => !consumed.has(i) && i.task === item.task && i.agent === item.agent && (!item.candidate || i.sha === item.candidate.sourceSha));
        if (!original || !lane || !['captured', 'duplicate', 'rejected'].includes(item.status) || (item.status === 'captured' && !item.candidate)) throw new Error('engine_result_mismatch');
        consumed.add(original);
        this.store.storage.sql.exec('UPDATE pushes SET status=? WHERE lane=? AND sha=?', item.status === 'rejected' ? 'rejected' : 'done', laneId, original.sha);
        if (item.candidate) {
          const candidate: Candidate = item.candidate;
          if (candidate.task !== item.task || candidate.agent !== item.agent || candidate.sourceSha !== original.sha || candidate.signedBy !== this.store.get<Agent>('agents', item.agent)?.publicKey) throw new Error('candidate_identity_mismatch');
          this.store.put('lanes', laneId, { ...lane, lastSeenSha: original.sha });
          // Ingest may update conflicts on existing alternatives as well as the
          // returned new capture. Publish the complete task view atomically in
          // syncCandidates(), never a half-refreshed candidate/conflict pair.
        }
      }
      for (const item of result.results) this.store.put('meta', `candidateSync:${item.task}`, true);
    }
    if (command === 'tests.record' && !result.ignored) this.store.put('meta', `candidateSync:${input.task}`, true);
    if (command === 'combine') this.store.put('meta', `candidateSync:${input.task}`, true);
    if (command === 'discuss') {
      this.store.put('turns', result.id, result);
      const reviewCurrent = !context.reviewHeads || (JSON.stringify(context.reviewHeads) === JSON.stringify(this.heads(input.task)) && !this.store.get('meta', `candidateSync:${input.task}`) && !this.store.get('decisions', input.task) && this.task(input.task).status === 'open' && !this.pendingPush(input.task) && !this.testsPending(input.task));
      if (context.review && reviewCurrent) { this.store.put('meta', `review:${input.task}`, context.review); events.push({ type: 'review.posted', turn: result, review: context.review }); }
      else events.push({ type: 'discussion.posted', turn: result });
    }
    if (command === 'decide') {
      if (!/^[a-f0-9]{40}$/.test(result.mainSha)) throw new Error('invalid_decision_projection');
      this.store.put('meta', `decisionMain:${input.task}`, result.mainSha);
      this.store.put('decisions', input.task, { ...result, mainSha: '' });
      for (const lane of this.store.all<Lane>('lanes').filter(l => l.task === input.task)) this.store.put('lanes', `${lane.task}/${lane.agent}`, { ...lane, status: lane.agent === input.pick ? 'released' : 'abandoned' });
    }
    if (command === 'publish') {
      if (!/^[a-f0-9]{40}$/.test(result.main) || !result.verify || ['exportRoundTrip', 'treeMatch', 'fsck'].some(key => result.verify[key] !== true)) throw new Error('invalid_publish_verification');
      const pending = this.store.all<Decision>('decisions').filter(d => !d.mainSha);
      if (pending.length > 1 || pending.some(d => this.store.get('meta', `decisionMain:${d.task}`) !== result.main)) throw new Error('publication_decision_mismatch');
      this.store.put('meta', 'mainSha', result.main); this.store.put('meta', 'verify', result.verify);
      // Publication-time evidence belongs to this exact Git commit. Never attach
      // the last publication's checks to a different historical or candidate SHA.
      this.store.put('meta', `verify:${result.main}`, { sha: result.main, exportRoundTrip: result.verify.exportRoundTrip, treeMatch: result.verify.treeMatch, fsck: result.verify.fsck, checkedAt: new Date().toISOString() });
      for (const decision of this.store.all<Decision>('decisions').filter(d => !d.mainSha)) {
        decision.mainSha = result.main; this.store.put('decisions', decision.task, decision);
        const task = this.store.get<Task>('tasks', decision.task)!; this.store.put('tasks', task.slug, { ...task, status: 'decided' });
        for (const lane of this.store.all<Lane>('lanes').filter(l => l.task === decision.task)) this.store.put('lanes', `${lane.task}/${lane.agent}`, { ...lane, status: lane.agent === decision.pick ? 'released' : 'abandoned' });
        events.push({ type: 'decision.landed', decision });
      }
    }
    return events;
  }
  private pendingPush(task: string): boolean { return this.store.rows<any>("SELECT id FROM pushes WHERE status IN ('pending','retry') AND json_extract(data, '$.task')=? LIMIT 1", task).length > 0; }
  private candidates(task: string): Candidate[] { return this.store.all<Candidate>('candidates').filter(c => c.task === task); }
  private awaitingLanes(task: string, candidates: Candidate[]): boolean {
    const agents = new Set(this.store.all<Agent>('agents').filter(a => a.kind === 'agent').map(a => a.id));
    const lanes = this.store.all<Lane>('lanes').filter(l => l.task === task && l.status === 'active' && agents.has(l.agent));
    if (lanes.every(l => candidates.some(c => c.agent === l.agent))) return false;
    const first = Math.min(...candidates.map(c => Date.parse(c.capturedAt)).filter(Number.isFinite));
    return !(Number.isFinite(first) && Date.now() - first >= REVIEW_WAIT_MS);
  }
  private testsPending(task: string): boolean { return this.candidates(task).some(c => c.tests?.status === 'pending'); }
  private heads(task: string): string[] { return this.candidates(task).map(c => c.state).sort(); }
  private task(task: string): Task { const value = this.store.get<Task>('tasks', task); if (!value) throw new HttpError(404, 'task_not_found'); return value; }
  private expireAccess(): boolean {
    const open = this.credentials.enforce();
    for (const socket of this.ctx.getWebSockets()) this.feedAuthorized(socket);
    return open;
  }
  private feedAuthorized(socket: WebSocket): boolean {
    const attachment = socket.deserializeAttachment() as { op?: boolean; agent?: string; hash?: string; expiresAt?: string } | null;
    let valid = this.credentials.isOpen() && !!attachment?.expiresAt && Date.parse(attachment.expiresAt) > Date.now();
    if (valid && !attachment?.op) {
      const row = this.store.rows<{ keyHash: string | null; keyExpiresAt: string | null }>('SELECT keyHash,keyExpiresAt FROM agents WHERE id=?', attachment?.agent ?? '')[0];
      valid = !!row?.keyHash && row.keyHash === attachment?.hash && !!row.keyExpiresAt && Date.parse(row.keyExpiresAt) > Date.now();
    }
    if (!valid) { try { socket.close(1008, 'credentials expired or project closed'); } catch {} }
    return valid;
  }
  private async recover() {
    const open = this.expireAccess();
    await this.credentials.sweep(!open, this.credentialRecovery); this.credentialRecovery = false;
    if (!open || !this.expireAccess()) return;
    await this.engine.replay();
    await this.syncCandidates();
    await this.refreshCombined();
    await this.recoverSandboxJobs();
    await this.revokeReleased();
    for (const decision of this.store.all<Decision>('decisions').filter(d => !d.mainSha)) {
      const opId = `publish:${decision.landState}`, previous = this.store.rows<{ status: string }>('SELECT status FROM ops WHERE id=?', opId)[0];
      if (previous && ['failed', 'rejected'].includes(previous.status)) continue;
      await this.engine.mutate('publish', { opId, canonical: { remote: this.store.get('meta', 'project').canonicalRemote } });
    }
  }
  private async revokeReleased() {
    for (const lane of this.store.all<Lane>('lanes').filter(l => l.status !== 'active')) {
      const id = `${lane.task}/${lane.agent}`, token = this.store.rows<{ tokenId: string | null }>('SELECT tokenId FROM lanes WHERE id=?', id)[0]?.tokenId;
      if (token) { await this.credentials.revoke(lane.forkRepo, token); this.store.storage.sql.exec('UPDATE lanes SET tokenId=NULL WHERE id=?', id); }
    }
  }
  private async nextAlarm() {
    const open = this.expireAccess(), credentialCheck = this.credentials.nextCheck();
    const active = open && this.store.all<Lane>('lanes').some(l => l.status === 'active');
    const reviews = open ? this.store.rows<{ data: string }>("SELECT data FROM meta WHERE key LIKE 'reviewDue:%'").map(r => JSON.parse(r.data) as number) : [];
    const pending = open && this.store.rows<any>("SELECT id FROM pushes WHERE status='pending' LIMIT 1").length > 0;
    const retries = open ? this.store.rows<{ id: string }>("SELECT id FROM pushes WHERE status='retry'").map(r => this.pushRetry(r.id)?.notBefore ?? Date.now()) : [];
    const jobs = open && this.sandboxJobs().some(j => j.status !== 'done');
    const when = Math.min(credentialCheck ?? Infinity, active || pending || jobs ? Date.now() + 3000 : Infinity, ...reviews, ...retries);
    if (Number.isFinite(when)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, when));
    else await this.ctx.storage.deleteAlarm();
  }
  async notePush(fork: string, ref: string, sha: string, via: 'event' | 'poll'): Promise<boolean> {
    if (!this.expireAccess()) { await this.nextAlarm(); return false; }
    if (ref !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(sha) || sha === '0'.repeat(40)) return false;
    const row = this.store.rows<{ id: string; data: string }>('SELECT id,data FROM lanes WHERE forkRepo=?', fork)[0];
    if (!row) return false; const lane = JSON.parse(row.data) as Lane;
    if (lane.status !== 'active' || this.store.get<Task>('tasks', lane.task)?.status === 'decided') return false;
    const id = `${row.id}:${sha}`;
    this.store.storage.sql.exec("INSERT OR IGNORE INTO pushes (id,lane,sha,data,status) VALUES (?,?,?,?, 'pending')", id, row.id, sha, JSON.stringify({ task: lane.task, agent: lane.agent, fork: { remote: lane.forkRemote }, ref, sha }));
    const inserted = this.store.rows<{ count: number }>('SELECT changes() AS count')[0].count === 1;
    if (inserted) this.emit({ type: 'push.received', task: lane.task, agent: lane.agent, sha, via });
    if (inserted) this.scheduleDrain(); await this.nextAlarm(); return inserted;
  }
  private scheduleDrain() {
    if (!this.expireAccess()) return;
    if (this.draining) return;
    this.draining = new Promise<void>(resolve => setTimeout(resolve, 25)).then(() => this.engine.serial(async () => { await this.recover(); if (this.expireAccess()) await this.drain(); await this.nextAlarm(); })).catch(() => {}).finally(() => { this.draining = undefined; });
    this.ctx.waitUntil(this.draining);
  }
  private async syncCandidates() {
    if (!this.expireAccess()) return;
    for (const task of this.store.all<Task>('tasks')) {
      if (!this.store.get('meta', `candidateSync:${task.slug}`)) continue;
      const result = await this.engine.read('candidates', { task: task.slug });
      this.store.storage.transactionSync(() => {
        for (const candidate of result.candidates as Candidate[]) {
          if (candidate.task !== task.slug || candidate.signedBy !== this.store.get<Agent>('agents', candidate.agent)?.publicKey) throw new Error('candidate_identity_mismatch');
          this.store.put('candidates', `${task.slug}/${candidate.agent}`, candidate);
        }
        this.store.put('meta', `reviewDue:${task.slug}`, Date.now() + 5000);
        this.store.storage.sql.exec('DELETE FROM meta WHERE key=?', `candidateSync:${task.slug}`);
      });
      for (const candidate of result.candidates as Candidate[]) {
        this.emit({ type: 'candidate.ready', candidate });
        if (candidate.tests) this.emit({ type: 'tests.done', task: candidate.task, agent: candidate.agent, sourceSha: candidate.sourceSha, tests: candidate.tests });
        if (candidate.tests?.status === 'pending' && candidate.tests.provenance === 'isolated sandbox') {
          const id = await sandboxId(this.store.get('meta', 'project').id, candidate);
          if (!this.store.get('meta', `isolated:${id}`)) this.store.put('meta', `isolated:${id}`, { id, task: candidate.task, agent: candidate.agent, sourceSha: candidate.sourceSha, treeSha: candidate.treeSha, status: 'queued' } satisfies SandboxJob);
        }
        const combined = candidate.combined;
        if (combined?.sha && combined.treeSha && combined.tests?.status === 'pending' && combined.tests.provenance === 'isolated sandbox') {
          const id = await sandboxId(this.store.get('meta', 'project').id, { task: candidate.task, agent: candidate.agent, sourceSha: combined.sha });
          if (!this.store.get('meta', `isolated:${id}`)) this.store.put('meta', `isolated:${id}`, { id, task: candidate.task, agent: candidate.agent, sourceSha: combined.sha, treeSha: combined.treeSha, status: 'queued',
            combined: { candidateSha: candidate.sourceSha, mainSha: combined.mainSha } } satisfies SandboxJob);
        }
      }
    }
    this.scheduleSandboxJobs();
  }
  /**
   * After main advances, re-check every open task whose base is behind it: Heddle merges each candidate
   * with the new main and the merged result is queued for the isolated sandbox. Once per task and main.
   */
  private async refreshCombined() {
    const main = this.store.get<string>('meta', 'mainSha');
    if (!main) return;
    // Synchronous selection: with nothing behind main this adds no await to recovery.
    const behind = this.store.all<Task>('tasks').filter(task => task.status === 'open' && !this.store.get('decisions', task.slug) && task.baseSha !== main &&
      this.store.get('meta', `combinedMain:${task.slug}`) !== main && this.candidates(task.slug).length > 0);
    if (!behind.length || !this.expireAccess()) return;
    for (const task of behind) {
      try {
        await this.engine.mutate('combine', { opId: `combine:${task.slug}:${main}`, task: task.slug, isolate: true });
        this.store.put('meta', `combinedMain:${task.slug}`, main);
      } catch {
        // A failed check must not stall recovery of everything else; a terminal failure is not retried.
        const op = this.store.rows<{ status: string }>('SELECT status FROM ops WHERE id=?', `combine:${task.slug}:${main}`)[0];
        if (op && ['failed', 'rejected'].includes(op.status)) this.store.put('meta', `combinedMain:${task.slug}`, main);
      }
    }
    await this.syncCandidates();
  }
  private sandboxJobs(): SandboxJob[] { return this.store.rows<{ data: string }>("SELECT data FROM meta WHERE key LIKE 'isolated:%'").map(r => JSON.parse(r.data)); }
  private runner(id: string): TestRunner | undefined { return this.env.TEST_RUNNER?.get(id) ?? this.env.TEST_SANDBOX?.getByName(id); }
  private sandboxError(job: SandboxJob, failure: SandboxRun['failure'] = 'sandbox'): SandboxRun {
    const recipe = this.testRecipe(), budgetMs = recipe?.budgetMs ?? TEST_BUDGET_MS;
    return { sourceSha: job.sourceSha, treeSha: job.treeSha, output: '', durationMs: Math.min(budgetMs, Date.now() - (job.startedAt ?? Date.now())), failure,
      ...(recipe ? { budgetMs } : {}), ...(this.env.DEV === '1' ? { fixture: true } : {}) };
  }
  /** The operator's recipe for this project's sandbox tests, if it set one at creation. */
  private testRecipe(): TestRecipe | undefined { return this.store.get<{ tests?: TestRecipe }>('meta', 'project')?.tests;
  }
  private async finishSandboxJob(job: SandboxJob) {
    if (!job.run) return;
    await this.engine.mutate('tests.record', job.combined
      ? { opId: `tests:${job.id}`, task: job.task, agent: job.agent, sourceSha: job.combined.candidateSha, combined: { sha: job.sourceSha, mainSha: job.combined.mainSha }, run: job.run }
      : { opId: `tests:${job.id}`, task: job.task, agent: job.agent, sourceSha: job.sourceSha, run: job.run });
    job.status = 'done'; this.store.put('meta', `isolated:${job.id}`, job);
    await this.syncCandidates();
  }
  private async recoverSandboxJobs() {
    for (const job of this.sandboxJobs()) {
      if (this.isolated.has(job.id) || job.status === 'done' || job.status === 'queued') continue;
      if (job.status === 'running') {
        // The original outcome is unknown after eviction. Destroy the instance
        // and record error; never reuse it or infer a successful run.
        try { await this.runner(job.id)?.destroy(); } catch {}
        job.run = this.sandboxError(job); job.status = 'observed';
        this.store.put('meta', `isolated:${job.id}`, job);
      }
      await this.finishSandboxJob(job);
    }
    this.scheduleSandboxJobs();
  }
  private scheduleSandboxJobs() {
    if (!this.credentials.isOpen()) return;
    for (const job of this.sandboxJobs()) {
      if (this.isolated.size >= 3) break;
      if (job.status !== 'queued' || this.isolated.has(job.id)) continue;
      // An agent that pushes as it goes queues a test run per push. A run for a push that is no longer
      // the agent's candidate would only be ignored when recorded, while holding one of three slots.
      if (this.supersededJob(job)) { job.status = 'done'; this.store.put('meta', `isolated:${job.id}`, job); continue; }
      job.status = 'running'; job.startedAt = Date.now(); this.store.put('meta', `isolated:${job.id}`, job);
      const promise = this.runSandboxJob(job).catch(() => {}).finally(() => { this.isolated.delete(job.id); this.scheduleSandboxJobs(); });
      this.isolated.set(job.id, promise); this.ctx.waitUntil(promise);
    }
  }
  private supersededJob(job: SandboxJob): boolean {
    const current = this.store.get<Candidate>('candidates', `${job.task}/${job.agent}`);
    if (!current) return false;
    if (job.combined) return current.sourceSha !== job.combined.candidateSha || current.combined?.sha !== job.sourceSha;
    return current.sourceSha !== job.sourceSha;
  }
  private async runSandboxJob(job: SandboxJob) {
    const lane = this.store.get<Lane>('lanes', `${job.task}/${job.agent}`), runner = this.runner(job.id);
    // A candidate is fetched from its fork. A combined commit exists only in the canonical repository
    // (the engine never writes to an agent's fork), so that job gets a canonical read grant instead.
    // Either way it is one repo, read-only, short-lived, attached outside the sandbox by TestOutbound.
    const project = this.store.get('meta', 'project'), repo = job.combined ? project.id : lane?.forkRepo, remote = job.combined ? project.canonicalRemote : lane?.forkRemote;
    let token: { id: string; plaintext: string } | undefined, run = this.sandboxError(job);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.ctx.storage.sync();
      if (!runner || !lane || lane.status !== 'active') throw new Error('sandbox_unavailable');
      token = await this.credentials.issue(repo, 'read', 'sandbox-read', job.agent, 240);
      this.credentials.assertOpen();
      const recipe = this.testRecipe(), budgetMs = recipe?.budgetMs ?? TEST_BUDGET_MS;
      const result = await Promise.race([runner.run({ project: project.id, task: job.task, agent: job.agent,
        sourceSha: job.sourceSha, treeSha: job.treeSha, remote, readCredential: token.plaintext, ...(recipe ? { recipe } : {}) }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('sandbox_timeout')), Math.max(1, budgetMs - (Date.now() - job.startedAt!))); })]);
      if (result.sourceSha !== job.sourceSha || result.treeSha !== job.treeSha) throw new Error('sandbox_binding');
      // Copy only observation fields; candidate output cannot supply test counts.
      run = { sourceSha: job.sourceSha, treeSha: job.treeSha, output: result.output, durationMs: result.durationMs, ...(recipe ? { budgetMs } : {}),
        installExitCode: result.installExitCode, testExitCode: result.testExitCode, ...(result.failure ? { failure: result.failure } : {}), ...(this.env.DEV === '1' ? { fixture: true } : {}) };
      if (typeof run.output !== 'string' || new TextEncoder().encode(run.output).length > TEST_OUTPUT_BYTES) run = this.sandboxError(job, 'output');
    } catch (error) { run = this.sandboxError(job, error instanceof Error && error.message === 'sandbox_timeout' ? 'timeout' : 'sandbox'); }
    finally {
      if (timer) clearTimeout(timer);
      try { await runner?.destroy(); } catch { run = this.sandboxError(job); }
      if (token && repo) await this.credentials.revoke(repo, token.id);
    }
    await this.engine.serial(async () => {
      job.run = run; job.status = 'observed'; this.store.put('meta', `isolated:${job.id}`, job); await this.ctx.storage.sync();
      if (this.expireAccess()) { await this.finishSandboxJob(job); await this.nextAlarm(); }
    });
  }
  /** A push whose ingest failed (not was rejected) is retried later: a transient Artifacts or engine failure must not lose a candidate. */
  private pushRetry(id: string): { count: number; notBefore: number } | undefined { return this.store.get('meta', `pushRetry:${id}`); }
  private requeueDuePushes(): void {
    for (const row of this.store.rows<{ id: string }>("SELECT id FROM pushes WHERE status='retry'")) {
      if ((this.pushRetry(row.id)?.notBefore ?? 0) <= Date.now()) this.store.storage.sql.exec("UPDATE pushes SET status='pending' WHERE id=?", row.id);
    }
  }
  private async drain() {
    if (!this.expireAccess()) return;
    this.requeueDuePushes();
    for (let batch = 0; batch < 10; batch++) {
    const rows = this.store.rows<{ id: string; data: string }>("SELECT id,data FROM pushes WHERE status='pending' ORDER BY rowid LIMIT 100");
    if (!rows.length) return;
    // A retry is a new operation: the failed one stays failed in the journal.
    const opId = `ingest:${await digest(rows.map(r => { const n = this.pushRetry(r.id)?.count; return n ? `${r.id}#retry${n}` : r.id; }).join('\n'))}`;
    try { await this.engine.mutate('ingest', { opId, items: rows.map(r => JSON.parse(r.data)), runTests: true, isolateUnreviewed: true }); }
    catch (error) {
      const terminal = this.store.rows<{ status: string }>('SELECT status FROM ops WHERE id=?', opId)[0];
      if (terminal?.status === 'rejected') for (const row of rows) this.store.storage.sql.exec("UPDATE pushes SET status='failed' WHERE id=?", row.id);
      else if (terminal?.status === 'failed') for (const row of rows) {
        const count = this.pushRetry(row.id)?.count ?? 0;
        if (count >= PUSH_RETRIES) { this.store.storage.sql.exec("UPDATE pushes SET status='failed' WHERE id=?", row.id); continue; }
        this.store.put('meta', `pushRetry:${row.id}`, { count: count + 1, notBefore: Date.now() + PUSH_RETRY_MS * 2 ** count });
        this.store.storage.sql.exec("UPDATE pushes SET status='retry' WHERE id=?", row.id);
      }
      throw error;
    }
    await this.syncCandidates();
    // An incomplete engine response must not leave acknowledged pushes permanently pending.
    const remaining = this.store.rows<{ id: string }>("SELECT id FROM pushes WHERE status='pending' LIMIT 1");
    if (!remaining.length) return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 3000);
  }
  async poll() {
    if (!this.expireAccess()) return;
    for (const lane of this.store.all<Lane>('lanes').filter(l => l.status === 'active')) {
      try { using repo = await artifacts(this.env).get(lane.forkRepo); const [tip] = await repo.log({ ref: 'main', limit: 1 }); if (tip && tip.hash !== lane.lastSeenSha) await this.notePush(lane.forkRepo, 'refs/heads/main', tip.hash, 'poll'); } catch {}
    }
  }
  private async reviews() {
    if (!this.expireAccess()) return;
    for (const task of this.store.all<Task>('tasks')) {
      const due = this.store.get<number>('meta', `reviewDue:${task.slug}`); if (!due || due > Date.now()) continue;
      if (this.testsPending(task.slug)) { this.store.put('meta', `reviewDue:${task.slug}`, Date.now() + 5000); continue; }
      const candidates = this.candidates(task.slug);
      if (task.status === 'decided' || !(candidates.length >= 2 || candidates.some(c => !c.conflicts.length && c.tests?.status === 'pass'))) { this.store.storage.sql.exec('DELETE FROM meta WHERE key=?', `reviewDue:${task.slug}`); continue; }
      // Review the whole field, not the first arrival: wait until every active agent lane has a
      // candidate, or REVIEW_WAIT_MS after the first one so a lane that never delivers cannot block review.
      if (this.awaitingLanes(task.slug, candidates)) { this.store.put('meta', `reviewDue:${task.slug}`, Date.now() + 5000); continue; }
      const reviewer = this.store.all<Agent>('agents').find(a => a.kind === 'reviewer');
      if (!reviewer || !this.env.REVIEW) { this.store.storage.sql.exec('DELETE FROM meta WHERE key=?', `reviewDue:${task.slug}`); continue; }
      const heads = this.heads(task.slug), headKey = await digest(heads.join(':'));
      const key = `reviewAttempt:${task.slug}:${headKey}`, opId = `review:${headKey}`;
      let attempt = this.store.get<any>('meta', key);
      const current = () => this.credentials.isOpen() && this.task(task.slug).status === 'open' &&
        !this.store.get('decisions', task.slug) && !this.store.get('meta', `candidateSync:${task.slug}`) &&
        !this.pendingPush(task.slug) && !this.testsPending(task.slug) &&
        JSON.stringify(this.heads(task.slug)) === JSON.stringify(heads);
      try {
        if (!attempt) {
          const diffs = [];
          for (const c of candidates) diffs.push({ agent: c.agent, tests: c.tests, diff: (await this.engine.read('diff', { task: task.slug, agent: c.agent, maxBytes: 524288 })).diff });
          if (!current()) throw new HttpError(409, 'review_inputs_changed');
          attempt = { status: 'reserved', heads, createdAt: new Date().toISOString(), diagnostics: [] };
          this.store.put('meta', key, attempt); this.store.put('meta', `lastReviewAttempt:${task.slug}`, key);
          await this.ctx.storage.sync();
          if (!current()) throw new HttpError(409, 'review_inputs_changed');
          attempt.review = await this.env.REVIEW.review({ intent: task.intent, base: task.baseSha, candidates: diffs, turns: this.store.all<Turn>('turns').filter(t => t.task === task.slug) }, {
            timeoutMs: 150000, maxAttempts: 1,
            onDiagnostic: diagnostic => { attempt.diagnostics.push(diagnostic); this.store.put('meta', key, attempt); },
          });
          attempt.status = 'prepared'; this.store.put('meta', key, attempt); await this.ctx.storage.sync();
        } else if (!attempt.review) {
          // A crash after reservation makes the provider outcome uncertain.
          // Preserve that fact and do not silently submit another inference.
          attempt.review = { summary: 'Automated review was interrupted. No replacement model call was made; inspect the evidence before deciding.', perCandidate: candidates.map(c => ({ agent: c.agent, verdict: 'concerns', notes: 'Review outcome unavailable after interruption. Human review required.' })), model: 'fallback' };
          attempt.status = 'interrupted'; this.store.put('meta', key, attempt); await this.ctx.storage.sync();
        }
        if (!current()) throw new HttpError(409, 'review_inputs_changed');
        const review = attempt.review as Review;
        const turn = await this.engine.mutate('discuss', { opId, task: task.slug, author: reviewer.id, body: JSON.stringify(review) }, { review, reviewHeads: heads });
        attempt.status = current() ? 'completed' : 'stale'; attempt.turnId = turn.id;
        this.store.put('meta', key, attempt);
        this.store.storage.sql.exec('DELETE FROM meta WHERE key=?', `reviewDue:${task.slug}`);
      } catch {
        const op = this.store.rows<{ status: string }>('SELECT status FROM ops WHERE id=?', opId)[0];
        if (!current() || op && ['failed', 'rejected'].includes(op.status)) this.store.storage.sql.exec('DELETE FROM meta WHERE key=?', `reviewDue:${task.slug}`);
        else this.store.put('meta', `reviewDue:${task.slug}`, Date.now() + 5000);
      }
    }
  }
  // Explicit operator recovery for a failed model call. Reservation survives
  // eviction before inference; retrying an uncertain request cannot bill again.
  private async retryReview(task: Task, body: any): Promise<Response> {
    const heads = this.heads(task.slug), key = `reviewRetry:${task.slug}`;
    if (!Array.isArray(body.expectHeads) || body.expectHeads.length !== heads.length ||
        [...body.expectHeads].sort().some((h, i) => h !== heads[i])) throw new HttpError(409, 'stale', { heads });
    const existing = this.store.get<any>('meta', key);
    if (existing) {
      if (existing.priorTurn !== body.priorTurn || JSON.stringify(existing.heads) !== JSON.stringify(heads)) throw new HttpError(409, 'retry_mismatch');
      return Response.json({ retry: existing, review: this.store.get('meta', `review:${task.slug}`) });
    }
    if (task.status !== 'open' || this.store.get('decisions', task.slug)) throw new HttpError(409, 'task_decided');
    const turns = this.store.all<Turn>('turns').filter(t => t.task === task.slug && t.kind === 'reviewer');
    const reviewer = this.store.all<Agent>('agents').find(a => a.kind === 'reviewer');
    const prior = turns[0], current = this.store.get<Review>('meta', `review:${task.slug}`);
    if (!reviewer || !this.env.REVIEW || turns.length !== 1 || prior.id !== body.priorTurn || prior.author !== reviewer.id ||
        current?.model !== 'fallback' || prior.body !== JSON.stringify(current)) throw new HttpError(409, 'retry_requires_fallback');
    const busy = () => this.store.get('meta', `candidateSync:${task.slug}`) || this.store.get('meta', `reviewDue:${task.slug}`) ||
      this.pendingPush(task.slug) || this.testsPending(task.slug);
    if (busy()) throw new HttpError(409, 'review_work_pending');
    const reservation: any = { priorTurn: prior.id, heads, status: 'reserved', createdAt: new Date().toISOString(), diagnostics: [] };
    this.store.put('meta', key, reservation); await this.ctx.storage.sync();
    const unchanged = () => {
      this.credentials.assertOpen();
      if (this.task(task.slug).status !== 'open' || this.store.get('decisions', task.slug) || busy() || JSON.stringify(this.heads(task.slug)) !== JSON.stringify(heads)) throw new HttpError(409, 'review_inputs_changed');
    };
    try {
      unchanged();
      const diffs = [];
      for (const c of this.candidates(task.slug)) diffs.push({ agent: c.agent, tests: c.tests, diff: (await this.engine.read('diff', { task: task.slug, agent: c.agent, maxBytes: 524288 })).diff });
      unchanged();
      const review = await this.env.REVIEW.review({ intent: task.intent, base: task.baseSha, candidates: diffs, turns: this.store.all<Turn>('turns').filter(t => t.task === task.slug) }, {
        timeoutMs: 150000, maxAttempts: 1,
        onDiagnostic: diagnostic => { reservation.diagnostics.push(diagnostic); this.store.put('meta', key, reservation); },
      });
      unchanged();
      const opId = `review-retry:${task.slug}:${await digest(heads.join(':'))}:1`;
      const turn = await this.engine.mutate('discuss', { opId, task: task.slug, author: reviewer.id, body: JSON.stringify(review) }, { review, reviewHeads: heads });
      unchanged();
      reservation.status = 'completed'; reservation.turnId = turn.id; reservation.model = review.model;
      reservation.completedAt = new Date().toISOString(); this.store.put('meta', key, reservation); await this.ctx.storage.sync();
      return Response.json({ retry: reservation, review, turn });
    } catch (error) {
      reservation.status = 'consumed'; this.store.put('meta', key, reservation); await this.ctx.storage.sync(); throw error;
    }
  }
  async alarm() {
    this.expireAccess();
    try { await this.engine.serial(async () => { await this.recover(); if (!this.expireAccess()) return; await this.poll(); await this.drain(); await this.reviews(); await this.revokeReleased(); }); }
    finally { await this.nextAlarm(); }
  }
  private async authorize(request: Request): Promise<{ op: boolean; agent?: Agent }> {
    this.expireAccess();
    checkOrigin(request); if (await operator(request, this.env.OPERATOR_TOKEN)) return { op: true };
    if (!this.credentials.isOpen() || !credential(request)) throw new HttpError(403, 'forbidden');
    const hash = await digest(credential(request));
    const row = this.store.rows<{ data: string; keyExpiresAt: string | null }>('SELECT data,keyExpiresAt FROM agents WHERE keyHash=?', hash)[0];
    if (!row?.keyExpiresAt || !Number.isFinite(Date.parse(row.keyExpiresAt)) || Date.parse(row.keyExpiresAt) <= Date.now()) throw new HttpError(403, 'forbidden'); return { op: false, agent: JSON.parse(row.data) };
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean), projectId = slug(parts[2]);
      // The demo project is a public showcase: its board, task, diff and Why reads
      // need no session. Writes, credentials and the live feed stay authenticated.
      const publicRead = request.method === 'GET' && projectId === this.env.DEMO_PROJECT && (parts.length === 3 || parts[3] === 'why' ||
        parts[3] === 'tasks' && (parts.length === 5 || parts.length === 6 && parts[5] === 'captures' || parts.length === 8 && parts[5] === 'candidates' && parts[7] === 'diff'));
      const anonymous = { op: false, agent: undefined };
      const actor = publicRead ? await this.authorize(request).catch(() => anonymous) : await this.authorize(request);
      const anonymousRead = publicRead && actor === anonymous;
      // Validate human registration before recovery can replay any pending engine writes.
      let human: { id: string; displayName: string; email?: string; sponsor?: true } | undefined;
      if (actor.op && parts[3] === 'humans' && request.method === 'POST') {
        const body = await jsonBody(request);
        human = { id: slug(body.id), displayName: text(body.displayName, 200),
          ...(body.email !== undefined ? { email: email(body.email) } : {}) };
        if (body.sponsor !== undefined && typeof body.sponsor !== 'boolean' || body.sponsor === true && !human.email) throw new HttpError(400, 'invalid_sponsor');
        if (body.sponsor === true) human.sponsor = true;
      }
      this.expireAccess();
      if (parts[3] === 'credentials' && (parts.length === 4 || parts[4] === 'status' && parts.length === 5) && request.method === 'GET' || parts[3] === 'cleanup' && parts.length === 4 && request.method === 'POST') {
        if (!actor.op) throw new HttpError(403, 'forbidden');
        if (!this.store.get('meta', 'project') && !this.credentials.lifetime()) throw new HttpError(404, 'project_not_found');
        if (parts[3] === 'cleanup') {
          if (request.body) await bodyText(request);
          this.credentials.close(); this.expireAccess();
          await this.ctx.storage.sync();
          await this.credentials.sweep(true);
          await this.nextAlarm();
        } else await this.credentials.importDebt();
        const status = this.credentials.status();
        return Response.json(status, { status: parts[3] === 'cleanup' && !status.complete ? 202 : 200, headers: { 'cache-control': 'no-store' } });
      }
      if (parts[3] === 'diagnostics' && parts.length === 4 && request.method === 'GET') {
        // Operator-only queue state for a live session: ids, states and error codes only, never payloads.
        if (!actor.op) throw new HttpError(403, 'forbidden');
        const error = (result: string | null) => { try { const r = JSON.parse(result ?? 'null'); return r?.error ?? r?.reason ?? r?.code; } catch { return undefined; } };
        // A failed op's result is only the engine client's fixed reason code and engine frames.
        const failure = (result: string | null) => { try { const r = JSON.parse(result ?? 'null'); return { reason: r?.reason, at: r?.at }; } catch { return {}; } };
        return Response.json({ open: this.credentials.isOpen(), alarm: await this.ctx.storage.getAlarm(), draining: !!this.draining,
          lanes: this.store.all<Lane>('lanes').map(l => ({ task: l.task, agent: l.agent, status: l.status, lastSeenSha: l.lastSeenSha })),
          pushes: this.store.rows<{ id: string; status: string }>('SELECT id,status FROM pushes ORDER BY rowid').map(r => ({ id: r.id, status: r.status })),
          ops: this.store.rows<{ id: string; command: string; status: string; attempts: number; result: string | null }>('SELECT id,command,status,attempts,result FROM ops ORDER BY rowid DESC LIMIT 40')
            .map(o => ({ id: o.id.slice(0, 48), command: o.command, status: o.status, attempts: o.attempts, error: error(o.result), ...(o.status === 'failed' ? failure(o.result) : {}) })),
          // Review attempts carry only the reviewer's payload-free diagnostics (reason codes, shapes, timings).
          reviews: this.store.rows<{ key: string; data: string }>(`SELECT key,data FROM meta WHERE key LIKE 'reviewAttempt:%' ORDER BY rowid DESC LIMIT 20`)
            .map(r => { const a = JSON.parse(r.data); return { id: r.key.slice('reviewAttempt:'.length, 80), status: a.status, createdAt: a.createdAt, model: a.review?.model, diagnostics: a.diagnostics ?? [] }; }) }, { headers: { 'cache-control': 'no-store' } });
      }
      if (parts[3] === 'ws' && request.method === 'GET') {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'websocket_required');
        this.credentials.assertOpen();
        const pair = new WebSocketPair();
        pair[1].serializeAttachment({ op: actor.op, agent: actor.agent?.id, hash: actor.agent ? await digest(credential(request)) : undefined, expiresAt: this.credentials.lifetime()!.expiresAt });
        this.ctx.acceptWebSocket(pair[1]); await this.nextAlarm();
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (request.method !== 'GET' && !actor.op && !(parts[3] === 'tasks' && parts[5] === 'turns') && !(parts[3] === 'agents' && parts[5] === 'token')) throw new HttpError(403, 'forbidden');
      // These views use only the last transactionally applied coordinator state.
      // A long ingest/test must not hold the board behind the native writer queue.
      // Authentication remains above this branch; native reads and all mutations
      // still serialize with recovery below. A snapshot may be stale until the
      // next candidate.ready event, never a partially applied native operation.
      if (request.method === 'GET' && (parts.length === 3 || (parts[3] === 'tasks' && parts.length === 5))) {
        if (!this.store.get('meta', 'project')) throw new HttpError(404, 'project_not_found');
        // Wake durable recovery without making the read wait for it. This also
        // resumes a journal after eviction when no active lane alarm survives.
        this.scheduleDrain();
        if (parts.length === 3) return Response.json({ project: this.store.get('meta', 'project'), agents: this.store.all('agents'), tasks: this.store.all<Task>('tasks').map(task => ({ ...task, lanes: this.store.all<Lane>('lanes').filter(l => l.task === task.slug), candidates: this.candidates(task.slug), decision: this.store.get('decisions', task.slug) })) });
        const taskId = slug(parts[4]), task = this.task(taskId);
        return Response.json({ task, candidates: this.candidates(taskId), turns: this.store.all<Turn>('turns').filter(t => t.task === taskId), review: this.store.get('meta', `review:${taskId}`), reviewAttempt: this.store.get('meta', this.store.get<string>('meta', `lastReviewAttempt:${taskId}`) ?? ''), decision: this.store.get('decisions', taskId), heads: this.heads(taskId) });
      }
      const response = await this.engine.serial(async () => {
        if (!anonymousRead) await this.recover();
        if (actor.agent) await this.authorize(request);
        if (request.method !== 'GET' && !(parts.length === 3 && request.method === 'POST' && !this.store.get('meta', 'project'))) this.credentials.assertOpen();
        const pending = this.store.all<Decision>('decisions').find(d => !d.mainSha);
        const retryingPending = parts[3] === 'tasks' && parts[4] === pending?.task && parts[5] === 'decision';
        if (pending && request.method !== 'GET' && !retryingPending) {
          // Drain the bounded request before responding so the outer Worker→DO
          // request stream cannot outlive its response in workerd.
          if (request.body) await bodyText(request);
          throw new HttpError(409, 'publication_pending', { task: pending.task });
        }
        if (parts.length === 3 && request.method === 'POST') {
          const body = await jsonBody(request), seed = body.seed;
          if (body.id !== projectId || !(seed?.template === 'demo' || typeof seed?.importUrl === 'string')) throw new HttpError(400, 'invalid_seed');
          if (seed.importUrl) { const parsed = new URL(seed.importUrl); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new HttpError(400, 'invalid_seed'); }
          const tests = body.tests === undefined ? undefined : parseTestRecipe(body.tests);
          this.credentials.initialize(); await this.nextAlarm();
          let project = this.store.get('meta', 'project');
          if (!project) {
            let created = await existingRepository(this.env, projectId);
            if (created) this.credentials.noteExistingRepository(projectId);
            else created = await this.credentials.bootstrap(projectId, () => artifacts(this.env).create(projectId, { setDefaultBranch: 'main' }));
            project = { id: projectId, canonicalRemote: created.remote, ...(tests ? { tests } : {}) }; this.store.put('meta', 'project', project);
          } else if (JSON.stringify(project.tests ?? null) !== JSON.stringify(tests ?? project.tests ?? null)) throw new HttpError(409, 'test_recipe_conflict');
          await this.engine.mutate('init', { opId: `init:${projectId}`, project: projectId, canonical: { remote: project.canonicalRemote }, seed });
          const token = await this.credentials.issue(projectId, 'read', 'canonical-read', 'operator');
          await this.nextAlarm();
          return Response.json({ ...project, readToken: token.plaintext, expiresAt: token.expiresAt, projectExpiresAt: this.credentials.lifetime()!.expiresAt }, { headers: { 'cache-control': 'no-store' } });
        }
        if (!this.store.get('meta', 'project')) throw new HttpError(404, 'project_not_found');
        if (parts[3] === 'humans' && request.method === 'POST') {
          const { id, displayName, email: address } = human!;
          const prior = this.store.get<Agent>('agents', id); if (prior && (prior.kind !== 'human' || prior.email !== address)) throw new HttpError(409, 'identity_exists');
          const sponsor = human!.sponsor || prior?.sponsor;
          if (sponsor && this.store.all<Agent>('agents').some(a => a.sponsor && a.id !== id)) throw new HttpError(409, 'sponsor_exists');
          await this.engine.mutate('agent.enroll', { opId: `enroll:${id}${sponsor ? ':sponsor' : ''}`, agent: { id, kind: 'human', displayName, ...(address !== undefined ? { email: address } : {}), ...(sponsor ? { sponsor: true } : {}) } });
          const agent = this.store.get<Agent>('agents', id)!; return Response.json({ id, publicKey: agent.publicKey });
        }
        if (parts[3] === 'why' && request.method === 'GET') {
          const sha = parts[4]; if (!/^[a-f0-9]{40}$/.test(sha)) throw new HttpError(400, 'invalid_sha');
          const why = await this.engine.read('why', { sha });
          const verify = this.store.get('meta', `verify:${sha}`);
          return Response.json({ sha, ...why, ...(verify?.sha === sha ? { verify } : {}), decision: this.store.all<Decision>('decisions').find(d => d.mainSha === sha), candidate: this.store.all<Candidate>('candidates').find(c => c.sourceSha === sha) });
        }
        if (parts[3] === 'agents' && parts[5] === 'token' && request.method === 'POST') {
          if (!actor.agent || actor.agent.id !== parts[4]) throw new HttpError(403, 'forbidden');
          const lanes = this.store.all<Lane>('lanes').filter(l => l.agent === actor.agent!.id && l.status === 'active');
          if (lanes.length !== 1) throw new HttpError(409, 'lane_ambiguous');
          return Response.json(await this.forkToken(lanes[0]));
        }
        if (parts[3] !== 'tasks') throw new HttpError(404, 'not_found');
        if (parts.length === 4 && request.method === 'POST') {
          const body = await jsonBody(request), task = slug(body.slug), intent = text(body.intent);
          const previous = this.store.get<Task>('tasks', task); if (previous && previous.intent !== intent) throw new HttpError(409, 'task_exists');
          const result = await this.engine.mutate('task.create', { opId: `task:${task}`, task, intent }); return Response.json({ slug: task, thread: result.thread, baseSha: result.baseSha });
        }
        const taskId = slug(parts[4]), task = this.task(taskId);
        if (parts[5] === 'review' && parts[6] === 'retry' && parts.length === 7 && request.method === 'POST') {
          if (!actor.op) throw new HttpError(403, 'forbidden');
          return this.retryReview(task, await jsonBody(request));
        }
        if (parts[5] === 'agents' && request.method === 'POST') {
          if (task.status === 'decided' || this.store.get('decisions', taskId)) throw new HttpError(409, 'task_decided');
          const body = await jsonBody(request), id = slug(body.id), kind = body.kind;
          if (!['agent', 'human', 'reviewer'].includes(kind)) throw new HttpError(400, 'invalid_kind');
          const agent = { id, kind, displayName: text(body.displayName, 200), ...(body.provider ? { provider: text(body.provider, 200) } : {}), ...(body.model ? { model: text(body.model, 200) } : {}) };
          const prior = this.store.get<Agent>('agents', id); if (prior && prior.kind !== kind) throw new HttpError(409, 'identity_exists');
          const laneId = `${taskId}/${id}`; let lane = this.store.get<Lane>('lanes', laneId);
          const name = await forkName(projectId, taskId, id);
          // Probe before native enrollment, which itself issues provider leases.
          // An uncertain read must leave enrollment and credential state alone.
          const existing = lane ? undefined : await existingRepository(this.env, name);
          await this.engine.mutate('agent.enroll', { opId: `enroll:${id}`, agent });
          if (!lane) {
            using canonical = await artifacts(this.env).get(projectId);
            const fork = existing ?? await this.credentials.bootstrap(name, () => canonical.fork(name, { defaultBranchOnly: true }));
            if (existing) this.credentials.noteExistingRepository(name);
            lane = { project: projectId, task: taskId, agent: id, forkRepo: name, forkRemote: fork.remote, laneThread: `task/${taskId}/${id}`, status: 'active', lastSeenSha: task.baseSha };
            this.store.storage.sql.exec('INSERT INTO lanes (id,forkRepo,data) VALUES (?,?,?)', laneId, name, JSON.stringify(lane));
          }
          await this.env.PROJECT.getByName('__routing__').registerFork(lane.forkRepo, projectId);
          // briefing:false opens a control lane: no pre-turn briefing, recorded as such (for with/without comparisons).
          await this.engine.mutate('lane.open', { opId: `lane:${laneId}`, task: taskId, agent: id, ...(body.briefing === false ? { brief: false } : {}) });
          const subscription = await subscribeFork(this.env, lane.forkRepo);
          this.store.storage.sql.exec('UPDATE lanes SET subscription=? WHERE id=?', subscription, laneId);
          const agentKey = randomKey(), agentKeyExpiresAt = this.credentials.lifetime()!.expiresAt;
          this.credentials.assertOpen();
          this.store.storage.sql.exec('UPDATE agents SET keyHash=?,keyExpiresAt=? WHERE id=?', await digest(agentKey), agentKeyExpiresAt, id);
          await this.ctx.storage.sync(); this.expireAccess();
          const fork = await this.forkToken(lane); const read = await this.credentials.issue(projectId, 'read', 'canonical-read', id);
          await this.nextAlarm(); return Response.json({ agentKey, agentKeyExpiresAt, projectExpiresAt: this.credentials.lifetime()!.expiresAt, briefing: this.store.get<Lane>('lanes', `${taskId}/${id}`)?.briefing, fork: { remote: lane.forkRemote, ...fork }, upstream: { remote: this.store.get('meta', 'project').canonicalRemote, readToken: read.plaintext, expiresAt: read.expiresAt }, setup: setupScript(lane.forkRemote, fork.token, this.store.get('meta', 'project').canonicalRemote, read.plaintext) }, { headers: { 'cache-control': 'no-store' } });
        }
        if (parts.length === 6 && parts[5] === 'captures' && request.method === 'GET') {
          // Stays inside this serial() block: the read can save engine.json and snapshot it (captures.test.ts).
          return Response.json(await this.engine.captures(taskId), { headers: { 'cache-control': 'no-store' } });
        }
        if (parts[5] === 'candidates' && parts[7] === 'diff' && request.method === 'GET') {
          const agent = slug(parts[6]); if (!this.candidates(taskId).some(c => c.agent === agent)) throw new HttpError(404, 'candidate_not_found');
          const { diff } = await this.engine.read('diff', { task: taskId, agent, maxBytes: 524288 });
          return new Response(new TextEncoder().encode(diff).slice(0, 524288), { headers: { 'content-type': 'text/x-diff' } });
        }
        if (parts[5] === 'turns' && request.method === 'POST') {
          const body = await jsonBody(request);
          const author = actor.agent?.id ?? body.as ?? this.store.all<Agent>('agents').find(a => a.kind === 'human')?.id;
          if (!author || (actor.agent && body.as && body.as !== actor.agent.id) || !this.store.get('agents', author)) throw new HttpError(403, 'identity_required');
          if (body.replyTo && !this.store.all<Turn>('turns').some(t => t.id === body.replyTo && t.task === taskId)) throw new HttpError(400, 'invalid_reply');
          return Response.json(await this.engine.mutate('discuss', { opId: crypto.randomUUID(), task: taskId, author, body: text(body.body), ...(body.replyTo ? { replyTo: body.replyTo } : {}) }));
        }
        if (parts[5] === 'decision' && request.method === 'POST') {
          const body = await jsonBody(request);
          try { decisionOptions(body); } catch (error) { if (error instanceof DecisionInputError) throw new HttpError(400, error.code, { message: error.message }); throw error; }
          await this.drain(); const heads = this.heads(taskId);
          if (!Array.isArray(body.expectHeads) || body.expectHeads.length !== heads.length || [...body.expectHeads].sort().some((h, i) => h !== heads[i])) throw new HttpError(409, 'stale', { heads });
          if (this.testsPending(taskId)) throw new HttpError(409, 'tests_pending');
          if (task.status === 'decided') throw new HttpError(409, 'task_decided');
          const decider = slug(body.decider); if (this.store.get<Agent>('agents', decider)?.kind !== 'human') throw new HttpError(403, 'human_decider_required');
          const pick = slug(body.pick), picked = this.candidates(taskId).find(c => c.agent === pick); if (!picked) throw new HttpError(400, 'candidate_not_found');
          // A pick checked combined with main lands only once that merged result passed (the engine re-checks).
          const refusal = picked.combined && !this.store.get('decisions', taskId) ? combinedRefusal(picked, this.store.get<string>('meta', 'mainSha')) : undefined;
          if (refusal) throw new HttpError(409, refusal.code, { message: refusal.message });
          const existing = this.store.get<Decision>('decisions', taskId);
          if (existing && (existing.pick !== pick || existing.decider !== decider || existing.rationale !== body.rationale || (body.anchor !== undefined && existing.anchor !== body.anchor) || JSON.stringify(existing.tags ?? []) !== JSON.stringify(body.tags ?? []))) throw new HttpError(409, 'decision_in_progress');
          if (!existing && body.anchor !== undefined) {
            try { await this.engine.read('decision.validate', { task: taskId, pick, anchor: body.anchor, ...(body.tags !== undefined ? { tags: body.tags } : {}) }); }
            catch (error) { if (error instanceof HttpError && error.code === 'invalid_anchor') throw new HttpError(400, 'invalid_anchor', { message: 'Anchor path must be a file in the tree being landed' }); throw error; }
          }
          const decision: Decision = existing ?? await this.engine.mutate('decide', { opId: crypto.randomUUID(), task: taskId, decider, pick, rationale: text(body.rationale), ...(body.anchor !== undefined ? { anchor: body.anchor } : {}), ...(body.tags !== undefined ? { tags: body.tags } : {}), expectHeads: body.expectHeads });
          await this.revokeReleased();
          await this.engine.mutate('publish', { opId: existing ? `publish:${decision.landState}:retry:${crypto.randomUUID()}` : `publish:${decision.landState}`, canonical: { remote: this.store.get('meta', 'project').canonicalRemote } });
          // Main moved: recovery re-checks open tasks behind it combined with the new main, in the
          // background, so the landing response does not wait for Heddle's merges and the sandbox.
          await this.revokeReleased(); this.scheduleDrain(); await this.nextAlarm(); return Response.json(this.store.get('decisions', taskId));
        }
        throw new HttpError(404, 'not_found');
      });
      if (actor.agent) await this.authorize(request);
      if (request.method !== 'GET') this.credentials.assertOpen();
      return response;
    } catch (error) { return responseError(error); }
  }
  private async forkToken(lane: Lane): Promise<{ token: string; expiresAt: string }> {
    this.credentials.assertOpen(); const id = `${lane.task}/${lane.agent}`;
    const old = this.store.rows<{ tokenId: string | null }>('SELECT tokenId FROM lanes WHERE id=?', id)[0]?.tokenId;
    const token = await this.credentials.issue(lane.forkRepo, 'write', 'fork-write', lane.agent);
    this.store.storage.sql.exec('UPDATE lanes SET tokenId=? WHERE id=?', token.id, id);
    if (old) await this.credentials.revoke(lane.forkRepo, old);
    this.credentials.assertOpen();
    return { token: token.plaintext, expiresAt: token.expiresAt };
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) { this.expireAccess(); if (this.feedAuthorized(socket) && message === 'ping') socket.send('pong'); }
  webSocketClose(socket: WebSocket, code: number) { socket.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); }
}
