// SPDX-License-Identifier: Apache-2.0
import type { Env } from './env';
import { artifacts } from './artifacts';
import { HttpError } from './auth';
import { streamSnapshot } from './snapshot';
import { Store } from './store';
import type { FeedEvent, Lane } from '../contracts/types';

type Journal = { id: string; command: string; input: string; context: string; status: string; result: string | null; attempts: number };
export class EngineClient {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private env: Env, private store: Store, private project: () => string, private apply: (cmd: string, input: any, result: any, context: any) => FeedEvent[], private emit: (e: FeedEvent) => void) {}
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
      throw new HttpError(code === 'stale' ? 409 : 422, code);
    }
    if (!response.ok) throw new Error('engine_crash');
    const line = (await response.text()).trim();
    if (line.includes('\n')) throw new Error('engine_protocol');
    return JSON.parse(line);
  }
  private async restore() {
    const generation = this.store.get<number>('meta', 'stateGeneration') ?? 0;
    if (!generation) return;
    const snapshot = await this.env.STATE.get(`projects/${this.project()}/gen-${generation}.tar.zst`);
    if (!snapshot) throw new Error('snapshot_missing');
    await this.parsed(await this.transport('restore', snapshot.body));
  }
  private async tokens<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const project = this.store.get('meta', 'project');
    const namespace = artifacts(this.env), leases: Array<{ repo: string; token: string }> = [];
    try {
      const reads: Record<string, string> = {};
      for (const lane of this.store.all<Lane>('lanes')) {
        using repo = await namespace.get(lane.forkRepo); const token = await repo.createToken('read', 600);
        leases.push({ repo: lane.forkRepo, token: token.id }); reads[lane.forkRemote] = token.plaintext;
      }
      let write = '';
      if (project) { using repo = await namespace.get(project.id); const token = await repo.createToken('write', 600); leases.push({ repo: project.id, token: token.id }); write = token.plaintext; }
      return await fn({ ARTIFACTS_READ_TOKENS: JSON.stringify(reads), ARTIFACTS_WRITE_TOKEN: write });
    } finally {
      for (const lease of leases) { try { using repo = await namespace.get(lease.repo); await repo.revokeToken(lease.token); } catch {} }
    }
  }
  async read(command: string, input: any): Promise<any> { await this.restore(); return this.parsed(await this.transport(command, JSON.stringify(input))); }
  async replay(): Promise<void> {
    const pending = this.store.rows<any>("SELECT * FROM ops WHERE status='pending' ORDER BY rowid");
    for (const op of pending) await this.perform(op);
  }
  async mutate(command: string, input: any, context: any = {}): Promise<any> {
    const previous = this.store.rows<any>('SELECT * FROM ops WHERE id=?', input.opId)[0];
    if (previous?.status === 'done') return JSON.parse(previous.result!);
    if (previous?.status === 'rejected' || previous?.status === 'failed') throw new HttpError(422, 'operation_failed');
    if (!previous) this.store.storage.sql.exec('INSERT INTO ops (id,command,input,context,status) VALUES (?,?,?,?,?)', input.opId, command, JSON.stringify(input), JSON.stringify(context), 'pending');
    return this.perform(previous ?? { id: input.opId, command, input: JSON.stringify(input), context: JSON.stringify(context), status: 'pending', result: null, attempts: 0 });
  }
  private async perform(op: Journal): Promise<any> {
    const input = JSON.parse(op.input), context = JSON.parse(op.context);
    for (let attempt = 0; attempt < 3; attempt++) {
      this.store.storage.sql.exec('UPDATE ops SET attempts=attempts+1 WHERE id=?', op.id);
      try {
        await this.restore();
        const result = await this.tokens(env => this.parsedPromise(op.command, input, env));
        const generation = this.store.get<number>('meta', 'stateGeneration') ?? 0;
        const response = await this.transport('snapshot', '{}');
        if (!response.ok || !response.body) throw new Error('snapshot_failed');
        await streamSnapshot(this.env.STATE, `projects/${this.project()}/gen-${generation + 1}.tar.zst`, response.body);
        let events: FeedEvent[] = [];
        this.store.storage.transactionSync(() => {
          if ((this.store.get<number>('meta', 'stateGeneration') ?? 0) !== generation) throw new Error('generation_conflict');
          this.store.put('meta', 'stateGeneration', generation + 1);
          events = this.apply(op.command, input, result, context);
          this.store.storage.sql.exec("UPDATE ops SET status='done',result=? WHERE id=?", JSON.stringify(result), op.id);
        });
        for (const event of events) this.emit(event);
        return result;
      } catch (error) {
        if (error instanceof HttpError && error.status < 500) {
          this.store.storage.sql.exec("UPDATE ops SET status='rejected' WHERE id=?", op.id);
          throw error;
        }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (2 ** attempt)));
      }
    }
    this.store.storage.sql.exec("UPDATE ops SET status='failed' WHERE id=?", op.id);
    this.emit({ type: 'engine.error', op: op.id, code: 'crash', message: 'Engine failed after three attempts; latest snapshot retained.' });
    throw new HttpError(503, 'engine_failed');
  }
  private async parsedPromise(command: string, input: any, env: Record<string, string>) { return this.parsed(await this.transport(command, JSON.stringify(input), env)); }
}
