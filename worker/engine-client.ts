// SPDX-License-Identifier: Apache-2.0
import type { Env } from './env';
import { DemoCredentials } from './credentials';
import { HttpError } from './auth';
import { streamSnapshot } from './snapshot';
import { Store } from './store';
import type { FeedEvent, Lane } from '../contracts/types';

type Journal = { id: string; command: string; input: string; context: string; status: string; result: string | null; attempts: number };
// Compare the JSON actually persisted in the journal, independent of object-key
// order. An opId is a retry of one command, never authority to change its input.
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Why an engine attempt failed: fixed reason codes and engine source frames only, never payloads or stderr. */
export type EngineFailureDetail = { reason: string; at?: string[] };
class EngineFailure extends Error { constructor(readonly detail: EngineFailureDetail) { super(detail.reason); } }
const REASON = /^[a-z][a-z0-9_]{0,63}$/, FRAME = /^engine\/(?:lib\/)?[a-z-]+\.mjs:\d+:\d+$/;
async function crashDetail(response: Response): Promise<EngineFailureDetail> {
  if (response.status === 504) return { reason: 'engine_timeout' };
  let error: any; try { error = JSON.parse((await response.text()).trim()).error; } catch { return { reason: 'engine_crash' }; }
  const at = Array.isArray(error?.at) ? error.at.filter((f: unknown) => typeof f === 'string' && FRAME.test(f)).slice(0, 3) : [];
  return { reason: typeof error?.reason === 'string' && REASON.test(error.reason) ? error.reason : 'engine_crash', ...(at.length ? { at } : {}) };
}
function failureDetail(error: unknown): EngineFailureDetail {
  if (error instanceof EngineFailure) return error.detail;
  // Worker-side failures in perform() throw fixed codes such as snapshot_failed; anything else stays opaque.
  return { reason: error instanceof Error && REASON.test(error.message) ? error.message : 'worker_error' };
}

export class EngineClient {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private env: Env, private store: Store, private project: () => string, private apply: (cmd: string, input: any, result: any, context: any) => FeedEvent[], private emit: (e: FeedEvent) => void, private credentials = new DemoCredentials(env, store)) {}
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result;
  }
  private async transport(command: string, body: BodyInit | null, env: Record<string, string> = {}): Promise<Response> {
    const request = new Request(`http://engine/${command}`, { method: 'POST', headers: { 'x-engine-env': JSON.stringify(env) }, body });
    if (this.env.DEV === '1' && this.env.ENGINE_DEV_URL) {
      return fetch(`${this.env.ENGINE_DEV_URL}/projects/${this.project()}/${command}`, { method: 'POST', headers: request.headers, body: request.body, signal: AbortSignal.timeout(180000) });
    }
    return this.env.ENGINE.getByName(this.project()).fetch(request);
  }
  private async parsed(response: Response): Promise<any> {
    if (response.status === 422) {
      const error = await response.json() as { error: { code: string; message: string } };
      const code = /^[a-z_]{1,40}$/.test(error.error?.code) ? error.error.code : 'rejected';
      // Combined-check refusals are state conflicts the decider resolves by waiting or re-briefing.
      throw new HttpError(code === 'stale' || code.startsWith('combined_') ? 409 : 422, code);
    }
    if (!response.ok) throw new EngineFailure(await crashDetail(response));
    const line = (await response.text()).trim();
    if (line.includes('\n')) throw new Error('engine_protocol');
    return JSON.parse(line);
  }
  // The snapshot generation this project's engine container holds on disk, and the token its restore wrote.
  // Restoring a real repository takes most of a minute, so a call skips it while the container still holds
  // that token. A failed call may leave the disk changed and a restarted container has no token; either
  // way the next call restores.
  private loaded: { generation: number; token: string } | undefined;
  private async restore() {
    const generation = this.store.get<number>('meta', 'stateGeneration') ?? 0;
    if (!generation) return;
    if (this.loaded?.generation === generation && await this.holds(this.loaded.token)) return;
    this.loaded = undefined;
    const snapshot = await this.env.STATE.get(`projects/${this.project()}/gen-${generation}.tar.zst`);
    if (!snapshot) throw new Error('snapshot_missing');
    const restored = await this.parsed(await this.transport('restore', snapshot.body));
    if (typeof restored?.loaded === 'string') this.loaded = { generation, token: restored.loaded };
  }
  private async holds(token: string): Promise<boolean> {
    try { return (await this.parsed(await this.transport('loaded', '{}')))?.loaded === token; } catch { return false; }
  }
  private async tokens<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    this.credentials.assertOpen();
    const project = this.store.get('meta', 'project'), leases: Array<{ repo: string; token: string }> = [];
    try {
      const reads: Record<string, string> = {};
      for (const lane of this.store.all<Lane>('lanes')) {
        const token = await this.credentials.issue(lane.forkRepo, 'read', 'engine-read', lane.agent, 600);
        leases.push({ repo: lane.forkRepo, token: token.id }); reads[lane.forkRemote] = token.plaintext;
      }
      let write = '';
      if (project) {
        const read = await this.credentials.issue(project.id, 'read', 'engine-read', 'engine', 600);
        leases.push({ repo: project.id, token: read.id }); reads[project.canonicalRemote] = read.plaintext;
        const token = await this.credentials.issue(project.id, 'write', 'engine-write', 'engine', 600);
        leases.push({ repo: project.id, token: token.id }); write = token.plaintext;
      }
      this.credentials.assertOpen();
      return await fn({ ARTIFACTS_READ_TOKENS: JSON.stringify(reads), ARTIFACTS_WRITE_TOKEN: write });
    } finally {
      // Failures are durable cleanup debt, never silently forgotten.
      for (const lease of leases) await this.credentials.revoke(lease.repo, lease.token);
    }
  }
  async read(command: string, input: any): Promise<any> {
    await this.restore();
    try { return await this.parsed(await this.transport(command, JSON.stringify(input))); }
    catch (error) { this.loaded = undefined; throw error; }
  }
  async replay(): Promise<void> {
    if (!this.credentials.isOpen()) return;
    const pending = this.store.rows<any>("SELECT * FROM ops WHERE status='pending' ORDER BY rowid");
    for (const op of pending) await this.perform(op);
  }
  async mutate(command: string, input: any, context: any = {}): Promise<any> {
    this.credentials.assertOpen();
    const previous = this.store.rows<any>('SELECT * FROM ops WHERE id=?', input.opId)[0];
    if (previous && (previous.command !== command || canonical(JSON.parse(previous.input)) !== canonical(JSON.parse(JSON.stringify(input))) || canonical(JSON.parse(previous.context)) !== canonical(JSON.parse(JSON.stringify(context))))) throw new HttpError(409, 'operation_mismatch');
    if (previous?.status === 'done') return JSON.parse(previous.result!);
    if (previous?.status === 'rejected' || previous?.status === 'failed') throw new HttpError(422, 'operation_failed');
    if (!previous) this.store.storage.sql.exec('INSERT INTO ops (id,command,input,context,status) VALUES (?,?,?,?,?)', input.opId, command, JSON.stringify(input), JSON.stringify(context), 'pending');
    return this.perform(previous ?? { id: input.opId, command, input: JSON.stringify(input), context: JSON.stringify(context), status: 'pending', result: null, attempts: 0 });
  }
  private async perform(op: Journal): Promise<any> {
    const input = JSON.parse(op.input), context = JSON.parse(op.context);
    let failure: EngineFailureDetail = { reason: 'engine_crash' };
    for (let attempt = 0; attempt < 3; attempt++) {
      this.store.storage.sql.exec('UPDATE ops SET attempts=attempts+1 WHERE id=?', op.id);
      try {
        this.credentials.assertOpen();
        await this.restore();
        this.credentials.assertOpen();
        const result = await this.tokens(env => this.parsedPromise(op.command, input, env));
        this.credentials.assertOpen();
        const generation = this.store.get<number>('meta', 'stateGeneration') ?? 0;
        const response = await this.transport('snapshot', '{}');
        if (!response.ok || !response.body) throw new Error('snapshot_failed');
        await streamSnapshot(this.env.STATE, `projects/${this.project()}/gen-${generation + 1}.tar.zst`, response.body);
        this.credentials.assertOpen();
        let events: FeedEvent[] = [];
        this.store.storage.transactionSync(() => {
          if ((this.store.get<number>('meta', 'stateGeneration') ?? 0) !== generation) throw new Error('generation_conflict');
          this.store.put('meta', 'stateGeneration', generation + 1);
          events = this.apply(op.command, input, result, context);
          this.store.storage.sql.exec("UPDATE ops SET status='done',result=? WHERE id=?", JSON.stringify(result), op.id);
        });
        // The disk now holds exactly what was just snapshotted as the next generation.
        if (this.loaded?.generation === generation) this.loaded = { generation: generation + 1, token: this.loaded.token };
        for (const event of events) this.emit(event);
        return result;
      } catch (error) {
        this.loaded = undefined;
        if (error instanceof HttpError && error.status < 500) {
          this.store.storage.sql.exec("UPDATE ops SET status='rejected' WHERE id=?", op.id);
          throw error;
        }
        failure = failureDetail(error);
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (2 ** attempt)));
      }
    }
    // Keep the last attempt's reason for operator diagnostics and Workers Logs.
    this.store.storage.sql.exec("UPDATE ops SET status='failed',result=? WHERE id=?", JSON.stringify({ error: 'engine_failed', ...failure }), op.id);
    console.error(JSON.stringify({ event: 'engine_op_failed', op: op.id, command: op.command, ...failure }));
    this.emit({ type: 'engine.error', op: op.id, code: 'crash', message: 'Engine failed after three attempts; latest snapshot retained.' });
    throw new HttpError(503, 'engine_failed');
  }
  private async parsedPromise(command: string, input: any, env: Record<string, string>) { return this.parsed(await this.transport(command, JSON.stringify(input), env)); }
}
