// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from 'cloudflare:workers';
import type { Agent, Candidate, Decision, FeedEvent, Lane, Review, Turn } from '../contracts/types';
import type { Env } from './env';
import { artifacts, forkName, setupScript, subscribeFork } from './artifacts';
import { checkOrigin, credential, digest, HttpError, jsonBody, operator, randomKey, responseError, slug, text } from './auth';
import { Store } from './store';
import { EngineClient } from './engine-client';

type Task = { slug: string; intent: string; thread: string; baseSha: string; status: 'open' | 'decided' };
export class ProjectDO extends DurableObject<Env> {
  store: Store;
  engine: EngineClient;
  private draining: Promise<void> | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env); this.store = new Store(ctx.storage);
    this.engine = new EngineClient(env, this.store, () => this.store.get('meta', 'project')?.id ?? '', this.apply.bind(this), this.emit.bind(this));
  }
  // Internal RPC registry: event routing never trusts task/agent fields in event input.
  registerFork(fork: string, project: string) { this.store.put('meta', `fork:${fork}`, project); }
  lookupFork(fork: string): string | undefined { return this.store.get('meta', `fork:${fork}`); }
  private emit(event: FeedEvent) {
    for (const socket of this.ctx.getWebSockets()) { try { socket.send(JSON.stringify(event)); } catch { socket.close(1011, 'feed unavailable'); } }
  }
  private apply(command: string, input: any, result: any, context: any) {
    if (command === 'init') this.store.put('meta', 'mainSha', result.mainSha);
    if (command === 'task.create') this.store.put('tasks', input.task, { slug: input.task, intent: input.intent, ...result, status: 'open' });
    if (command === 'agent.enroll') this.store.put('agents', input.agent.id, { ...input.agent, publicKey: result.publicKey });
    if (command === 'lane.open') {
      const lane = this.store.get<Lane>('lanes', `${input.task}/${input.agent}`)!;
      this.store.put('lanes', `${input.task}/${input.agent}`, { ...lane, laneThread: result.laneThread, status: 'active' });
    }
    if (command === 'ingest') {
      for (const item of result.results) {
        const laneId = `${item.task}/${item.agent}`, lane = this.store.get<Lane>('lanes', laneId);
        const original = input.items.find((i: any) => i.task === item.task && i.agent === item.agent && (!item.candidate || i.sha === item.candidate.sourceSha));
        if (!original || !lane) throw new Error('engine_result_mismatch');
        this.store.storage.sql.exec('UPDATE pushes SET status=? WHERE lane=? AND sha=?', item.status === 'rejected' ? 'rejected' : 'done', laneId, original.sha);
        if (item.candidate) {
          const candidate: Candidate = item.candidate;
          if (candidate.task !== item.task || candidate.agent !== item.agent || candidate.sourceSha !== original.sha || candidate.signedBy !== this.store.get<Agent>('agents', item.agent)?.publicKey) throw new Error('candidate_identity_mismatch');
          this.store.put('candidates', laneId, candidate);
          this.store.put('lanes', laneId, { ...lane, lastSeenSha: original.sha });
          this.emit({ type: 'candidate.ready', candidate });
          if (candidate.tests) this.emit({ type: 'tests.done', task: item.task, agent: item.agent, tests: candidate.tests });
          this.store.put('meta', `reviewDue:${item.task}`, Date.now() + 5000);
        }
      }
      // Existing candidates also acquire cross-referenced conflict previews.
      for (const [task, conflicts] of Object.entries(result.conflicts ?? {})) {
        for (const candidate of this.candidates(task)) {
          const own = (conflicts as Candidate['conflicts']).filter(c => c.with.includes(candidate.agent));
          if (own.length && !candidate.conflicts.length) {
            candidate.conflicts = own.map(c => ({ ...c, with: this.candidates(task).map(x => x.agent).filter(a => a !== candidate.agent) }));
            this.store.put('candidates', `${task}/${candidate.agent}`, candidate);
          }
        }
      }
    }
    if (command === 'discuss') {
      this.store.put('turns', result.id, result);
      if (context.review) { this.store.put('meta', `review:${input.task}`, context.review); this.emit({ type: 'review.posted', turn: result, review: context.review }); }
      else this.emit({ type: 'discussion.posted', turn: result });
    }
    if (command === 'decide') this.store.put('decisions', input.task, { ...result, mainSha: '' });
    if (command === 'publish') {
      this.store.put('meta', 'mainSha', result.main); this.store.put('meta', 'verify', result.verify);
      for (const decision of this.store.all<Decision>('decisions').filter(d => !d.mainSha)) {
        decision.mainSha = result.main; this.store.put('decisions', decision.task, decision);
        const task = this.store.get<Task>('tasks', decision.task)!; this.store.put('tasks', task.slug, { ...task, status: 'decided' });
        for (const lane of this.store.all<Lane>('lanes').filter(l => l.task === decision.task)) this.store.put('lanes', `${lane.task}/${lane.agent}`, { ...lane, status: lane.agent === decision.pick ? 'released' : 'abandoned' });
        this.emit({ type: 'decision.landed', decision });
      }
    }
  }
  private candidates(task: string): Candidate[] { return this.store.all<Candidate>('candidates').filter(c => c.task === task); }
  private heads(task: string): string[] { return this.candidates(task).map(c => c.state).sort(); }
  private task(task: string): Task { const value = this.store.get<Task>('tasks', task); if (!value) throw new HttpError(404, 'task_not_found'); return value; }
  private async recover() {
    await this.engine.replay();
    for (const decision of this.store.all<Decision>('decisions').filter(d => !d.mainSha)) await this.engine.mutate('publish', { opId: `publish:${decision.landState}`, canonical: { remote: this.store.get('meta', 'project').canonicalRemote } });
  }
  private async revokeReleased() {
    for (const lane of this.store.all<Lane>('lanes').filter(l => l.status !== 'active')) {
      const id = `${lane.task}/${lane.agent}`, token = this.store.rows<{ tokenId: string | null }>('SELECT tokenId FROM lanes WHERE id=?', id)[0]?.tokenId;
      if (token) { using repo = await artifacts(this.env).get(lane.forkRepo); await repo.revokeToken(token); this.store.storage.sql.exec('UPDATE lanes SET tokenId=NULL WHERE id=?', id); }
    }
  }
  private async nextAlarm() {
    const active = this.store.all<Lane>('lanes').some(l => l.status === 'active');
    const reviews = this.store.rows<{ data: string }>("SELECT data FROM meta WHERE key LIKE 'reviewDue:%'").map(r => JSON.parse(r.data) as number);
    const pending = this.store.rows<any>("SELECT id FROM pushes WHERE status='pending' LIMIT 1").length > 0;
    if (active || pending || reviews.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(active || pending ? Date.now() + 3000 : Infinity, ...reviews)));
    else await this.ctx.storage.deleteAlarm();
  }
  async notePush(fork: string, ref: string, sha: string, via: 'event' | 'poll'): Promise<boolean> {
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
    if (this.draining) return;
    this.draining = new Promise<void>(resolve => setTimeout(resolve, 25)).then(() => this.engine.serial(async () => { await this.recover(); await this.drain(); })).catch(() => {}).finally(() => { this.draining = undefined; });
    this.ctx.waitUntil(this.draining);
  }
  private async drain() {
    const rows = this.store.rows<{ id: string; data: string }>("SELECT id,data FROM pushes WHERE status='pending' ORDER BY rowid LIMIT 100");
    if (!rows.length) return;
    const opId = `ingest:${await digest(rows.map(r => r.id).join('\n'))}`;
    await this.engine.mutate('ingest', { opId, items: rows.map(r => JSON.parse(r.data)), runTests: true });
    // An incomplete engine response must not leave acknowledged pushes permanently pending.
    const remaining = this.store.rows<{ id: string }>("SELECT id FROM pushes WHERE status='pending' LIMIT 1");
    if (remaining.length) await this.ctx.storage.setAlarm(Date.now() + 3000);
  }
  async poll() {
    for (const lane of this.store.all<Lane>('lanes').filter(l => l.status === 'active')) {
      try { using repo = await artifacts(this.env).get(lane.forkRepo); const [tip] = await repo.log({ ref: 'main', limit: 1 }); if (tip && tip.id !== lane.lastSeenSha) await this.notePush(lane.forkRepo, 'refs/heads/main', tip.id, 'poll'); } catch {}
    }
  }
  private async reviews() {
    for (const task of this.store.all<Task>('tasks')) {
      const due = this.store.get<number>('meta', `reviewDue:${task.slug}`); if (!due || due > Date.now()) continue;
      const candidates = this.candidates(task.slug);
      if (task.status === 'decided' || !(candidates.length >= 2 || candidates.some(c => !c.conflicts.length && c.tests?.status === 'pass'))) { this.store.storage.sql.exec('DELETE FROM meta WHERE key=?', `reviewDue:${task.slug}`); continue; }
      const reviewer = this.store.all<Agent>('agents').find(a => a.kind === 'reviewer');
      if (!reviewer || !this.env.REVIEW) { this.store.storage.sql.exec('DELETE FROM meta WHERE key=?', `reviewDue:${task.slug}`); continue; }
      try {
        const input = { intent: task.intent, base: task.baseSha, candidates: await Promise.all(candidates.map(async c => ({ agent: c.agent, tests: c.tests, diff: (await this.engine.read('diff', { task: task.slug, agent: c.agent, maxBytes: 524288 })).diff }))), turns: this.store.all<Turn>('turns').filter(t => t.task === task.slug) };
        const review: Review = await this.env.REVIEW.review(input);
        await this.engine.mutate('discuss', { opId: `review:${await digest(this.heads(task.slug).join(':'))}`, task: task.slug, author: reviewer.id, body: JSON.stringify(review) }, { review });
        this.store.storage.sql.exec('DELETE FROM meta WHERE key=?', `reviewDue:${task.slug}`);
      } catch { this.store.put('meta', `reviewDue:${task.slug}`, Date.now() + 5000); }
    }
  }
  async alarm() { await this.poll(); await this.engine.serial(async () => { await this.recover(); await this.drain(); await this.reviews(); await this.revokeReleased(); }); await this.nextAlarm(); }
  private async authorize(request: Request): Promise<{ op: boolean; agent?: Agent }> {
    checkOrigin(request); if (await operator(request, this.env.OPERATOR_TOKEN)) return { op: true };
    if (!credential(request)) throw new HttpError(403, 'forbidden');
    const hash = await digest(credential(request));
    const row = this.store.rows<{ data: string }>('SELECT data FROM agents WHERE keyHash=?', hash)[0];
    if (!row) throw new HttpError(403, 'forbidden'); return { op: false, agent: JSON.parse(row.data) };
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean), projectId = slug(parts[2]);
      const publicWhy = request.method === 'GET' && parts[3] === 'why' && projectId === this.env.DEMO_PROJECT;
      const actor = publicWhy ? { op: false, agent: undefined } : await this.authorize(request);
      if (parts[3] === 'ws' && request.method === 'GET') {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'websocket_required');
        const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (request.method !== 'GET' && !actor.op && !(parts[3] === 'tasks' && parts[5] === 'turns') && !(parts[3] === 'agents' && parts[5] === 'token')) throw new HttpError(403, 'forbidden');
      return await this.engine.serial(async () => {
        await this.recover();
        if (parts.length === 3 && request.method === 'POST') {
          const body = await jsonBody(request), seed = body.seed;
          if (body.id !== projectId || !(seed?.template === 'demo' || typeof seed?.importUrl === 'string')) throw new HttpError(400, 'invalid_seed');
          if (seed.importUrl) { const parsed = new URL(seed.importUrl); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new HttpError(400, 'invalid_seed'); }
          let project = this.store.get('meta', 'project');
          if (!project) {
            let created;
            try { using existing = await artifacts(this.env).get(projectId); created = await existing.info(); } catch { created = await artifacts(this.env).create(projectId, { setDefaultBranch: 'main' }); }
            project = { id: projectId, canonicalRemote: created.remote }; this.store.put('meta', 'project', project);
            if ('token' in created && created.token) { using repo = await artifacts(this.env).get(projectId); await repo.revokeToken(created.token as string); }
          }
          await this.engine.mutate('init', { opId: `init:${projectId}`, project: projectId, canonical: { remote: project.canonicalRemote }, seed });
          using canonical = await artifacts(this.env).get(projectId); const token = await canonical.createToken('read', 43200);
          return Response.json({ ...project, readToken: token.plaintext });
        }
        if (!this.store.get('meta', 'project')) throw new HttpError(404, 'project_not_found');
        if (parts.length === 3 && request.method === 'GET') return Response.json({ project: this.store.get('meta', 'project'), agents: this.store.all('agents'), tasks: this.store.all<Task>('tasks').map(task => ({ ...task, lanes: this.store.all<Lane>('lanes').filter(l => l.task === task.slug), candidates: this.candidates(task.slug), decision: this.store.get('decisions', task.slug) })) });
        if (parts[3] === 'humans' && request.method === 'POST') {
          const body = await jsonBody(request), id = slug(body.id), displayName = text(body.displayName, 200);
          await this.engine.mutate('agent.enroll', { opId: `enroll:${id}`, agent: { id, kind: 'human', displayName } });
          const agent = this.store.get<Agent>('agents', id)!; return Response.json({ id, publicKey: agent.publicKey });
        }
        if (parts[3] === 'why' && request.method === 'GET') {
          const sha = parts[4]; if (!/^[a-f0-9]{40}$/.test(sha)) throw new HttpError(400, 'invalid_sha');
          const why = await this.engine.read('why', { sha }); return Response.json({ sha, ...why, decision: this.store.all<Decision>('decisions').find(d => d.mainSha === sha), candidate: this.store.all<Candidate>('candidates').find(c => c.sourceSha === sha) });
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
        if (parts.length === 5 && request.method === 'GET') return Response.json({ task, candidates: this.candidates(taskId), turns: this.store.all<Turn>('turns').filter(t => t.task === taskId), review: this.store.get('meta', `review:${taskId}`), decision: this.store.get('decisions', taskId), heads: this.heads(taskId) });
        if (parts[5] === 'agents' && request.method === 'POST') {
          if (task.status === 'decided') throw new HttpError(409, 'task_decided');
          const body = await jsonBody(request), id = slug(body.id), kind = body.kind;
          if (!['agent', 'human', 'reviewer'].includes(kind)) throw new HttpError(400, 'invalid_kind');
          const agent = { id, kind, displayName: text(body.displayName, 200), ...(body.provider ? { provider: text(body.provider, 200) } : {}), ...(body.model ? { model: text(body.model, 200) } : {}) };
          const prior = this.store.get<Agent>('agents', id); if (prior && prior.kind !== kind) throw new HttpError(409, 'identity_exists');
          await this.engine.mutate('agent.enroll', { opId: `enroll:${id}`, agent });
          const laneId = `${taskId}/${id}`; let lane = this.store.get<Lane>('lanes', laneId);
          if (!lane) {
            using canonical = await artifacts(this.env).get(projectId); const name = await forkName(projectId, taskId, id);
            let fork; try { using existing = await artifacts(this.env).get(name); fork = await existing.info(); } catch { fork = await canonical.fork(name, { defaultBranchOnly: true }); }
            lane = { project: projectId, task: taskId, agent: id, forkRepo: name, forkRemote: fork.remote, laneThread: `task/${taskId}/${id}`, status: 'active', lastSeenSha: task.baseSha };
            this.store.storage.sql.exec('INSERT INTO lanes (id,forkRepo,data) VALUES (?,?,?)', laneId, name, JSON.stringify(lane));
            if ('token' in fork && fork.token) { using repo = await artifacts(this.env).get(name); await repo.revokeToken(fork.token as string); }
          }
          await this.env.PROJECT.getByName('__routing__').registerFork(lane.forkRepo, projectId);
          await this.engine.mutate('lane.open', { opId: `lane:${laneId}`, task: taskId, agent: id });
          const subscription = await subscribeFork(this.env, lane.forkRepo);
          this.store.storage.sql.exec('UPDATE lanes SET subscription=? WHERE id=?', subscription, laneId);
          const agentKey = randomKey(); this.store.storage.sql.exec('UPDATE agents SET keyHash=? WHERE id=?', await digest(agentKey), id);
          const fork = await this.forkToken(lane); using canonical = await artifacts(this.env).get(projectId); const read = await canonical.createToken('read', 43200);
          await this.nextAlarm(); return Response.json({ agentKey, fork: { remote: lane.forkRemote, ...fork }, upstream: { remote: this.store.get('meta', 'project').canonicalRemote, readToken: read.plaintext }, setup: setupScript(lane.forkRemote, fork.token, this.store.get('meta', 'project').canonicalRemote, read.plaintext) });
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
          await this.drain(); const body = await jsonBody(request), heads = this.heads(taskId);
          if (!Array.isArray(body.expectHeads) || body.expectHeads.length !== heads.length || [...body.expectHeads].sort().some((h, i) => h !== heads[i])) throw new HttpError(409, 'stale', { heads });
          if (task.status === 'decided') throw new HttpError(409, 'task_decided');
          const decider = slug(body.decider); if (this.store.get<Agent>('agents', decider)?.kind !== 'human') throw new HttpError(403, 'human_decider_required');
          const pick = slug(body.pick); if (!this.candidates(taskId).some(c => c.agent === pick)) throw new HttpError(400, 'candidate_not_found');
          const decision: Decision = await this.engine.mutate('decide', { opId: crypto.randomUUID(), task: taskId, decider, pick, rationale: text(body.rationale), expectHeads: body.expectHeads });
          await this.engine.mutate('publish', { opId: `publish:${decision.landState}`, canonical: { remote: this.store.get('meta', 'project').canonicalRemote } });
          await this.revokeReleased(); await this.nextAlarm(); return Response.json(this.store.get('decisions', taskId));
        }
        throw new HttpError(404, 'not_found');
      });
    } catch (error) { return responseError(error); }
  }
  private async forkToken(lane: Lane): Promise<{ token: string; expiresAt: string }> {
    using repo = await artifacts(this.env).get(lane.forkRepo); const id = `${lane.task}/${lane.agent}`;
    const old = this.store.rows<{ tokenId: string | null }>('SELECT tokenId FROM lanes WHERE id=?', id)[0]?.tokenId;
    const token = await repo.createToken('write', 43200);
    this.store.storage.sql.exec('UPDATE lanes SET tokenId=? WHERE id=?', token.id ?? token.plaintext.split('?')[0], id);
    if (old) await repo.revokeToken(old);
    return { token: token.plaintext, expiresAt: token.expiresAt };
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) { if (message === 'ping') socket.send('pong'); }
  webSocketClose(socket: WebSocket, code: number) { socket.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); }
}
