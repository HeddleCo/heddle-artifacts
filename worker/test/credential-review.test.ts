// SPDX-License-Identifier: Apache-2.0
// Independent adversarial review. All providers and credential values are fixtures.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF, env as testEnv, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import type { Env, RepoToken } from '../env';
import { DemoCredentials, demoTtl, DEFAULT_DEMO_TTL, MAX_DEMO_TTL } from '../credentials';
import type { Store } from '../store';
import { memoryArtifacts } from '../../dev/memory-artifacts';

const env = testEnv as unknown as Env;
const operator = 'test-operator';
const sha = (n: number) => n.toString(16).padStart(40, '0');

function credentialFixture() {
  const tables = new Map<string, Map<string, any>>(), debt = new Map<string, any>();
  const minted = new Map<string, string>(), revoked: string[] = [];
  let syncCount = 0;
  const hooks: {
    sync?: (count: number) => void | Promise<void>;
    put?: (table: string, value: any) => void;
    mint?: (scope: string, ttl: number) => Promise<RepoToken>;
    revoke?: (id: string) => Promise<boolean>;
  } = {};
  const store = {
    get(table: string, key: string) { const value = tables.get(table)?.get(key); return value === undefined ? undefined : structuredClone(value); },
    put(table: string, key: string, value: any) { hooks.put?.(table, value); if (!tables.has(table)) tables.set(table, new Map()); tables.get(table)!.set(key, structuredClone(value)); },
    all(table: string) { return [...(tables.get(table)?.values() ?? [])].map(value => structuredClone(value)); },
    rows() { return []; },
    storage: {
      sql: { exec() {} },
      async sync() { await hooks.sync?.(++syncCount); },
      async put(key: string, value: any) { debt.set(key, structuredClone(value)); },
      async list() { return new Map(debt); },
      async delete(key: string) { return debt.delete(key); },
    },
  } as unknown as Store;
  const fixtureEnv = {
    DEV: '0',
    ARTIFACTS: {
      async get() {
        return {
          [Symbol.dispose]() {},
          async createToken(scope: string, ttl: number) {
            if (hooks.mint) return hooks.mint(scope, ttl);
            const id = crypto.randomUUID(), plaintext = `fixture-secret-${crypto.randomUUID()}`;
            minted.set(id, plaintext);
            return { id, plaintext, expiresAt: new Date(Math.min(Date.now() + ttl * 1000, Date.parse(store.get('meta', 'credentialLifetime').expiresAt))).toISOString() };
          },
          async revokeToken(id: string) { revoked.push(id); return hooks.revoke ? hooks.revoke(id) : minted.delete(id); },
        };
      },
    },
  } as unknown as Env;
  const credentials = new DemoCredentials(fixtureEnv, store);
  credentials.initialize();
  return { credentials, store, fixtureEnv, tables, debt, minted, revoked, hooks };
}

async function api(path: string, body?: any, token: string | null = operator) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function ok(path: string, body?: any, token: string | null = operator) {
  const response = await api(path, body, token), value = await response.json() as any;
  expect(response.status, JSON.stringify(value)).toBe(200); return value;
}
async function projectFixture() {
  const id = `review-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${id}`;
  const created = await ok('/api/projects', { id, seed: { template: 'demo' } });
  await ok(`${base}/tasks`, { slug: 'test-task', intent: 'Independent credential review fixture' });
  const joined = await ok(`${base}/tasks/test-task/agents`, { id: 'fixture-agent', kind: 'agent', displayName: 'Fixture agent' });
  return { id, base, created, joined, project: env.PROJECT.getByName(id), engine: env.ENGINE.getByName(id) as unknown as { stats(): Promise<any>; delayNext(command: string, ms: number): Promise<void>; failNext(command: string, count?: number, after?: boolean): Promise<void> } };
}

afterEach(() => vi.restoreAllMocks());

describe('independent credential ledger adversarial review', () => {
  it('defaults to one hour and rejects unbounded or malformed configuration', () => {
    expect(demoTtl({})).toBe(DEFAULT_DEMO_TTL); expect(demoTtl({ DEMO_CREDENTIAL_TTL_SECONDS: String(MAX_DEMO_TTL) })).toBe(7200);
    for (const value of ['0', '59', '7201', 'Infinity', '-1', '60.5', '', 'NaN']) {
      expect(() => demoTtl({ DEMO_CREDENTIAL_TTL_SECONDS: value })).toThrow('invalid_demo_credential_ttl');
    }
  });

  it('persists a non-secret receipt before mint and an ID before plaintext release', async () => {
    const f = credentialFixture();
    f.hooks.mint = async (_scope, ttl) => {
      expect(f.credentials.records()).toHaveLength(1);
      expect(f.credentials.records()[0]).toMatchObject({ id: null, status: 'issuing' });
      return { id: 'known-fixture-id', plaintext: 'fixture-only-bearer', expiresAt: new Date(Math.min(Date.now() + ttl * 1000, Date.parse(f.credentials.lifetime()!.expiresAt))).toISOString() };
    };
    const token = await f.credentials.issue('repo', 'read', 'canonical-read', 'operator');
    expect(f.credentials.records()).toEqual([expect.objectContaining({ id: token.id, status: 'active' })]);
    expect(JSON.stringify([...f.tables.entries()].map(([key, value]) => [key, [...value.entries()]]))).not.toContain(token.plaintext);
    expect(JSON.stringify(f.credentials.status())).not.toContain(token.plaintext);
  });

  it('compensates if cleanup closes the project during the final durable sync', async () => {
    const f = credentialFixture();
    f.hooks.sync = count => { if (count === 2) f.credentials.close(); };
    await expect(f.credentials.issue('repo', 'read', 'canonical-read', 'operator')).rejects.toBeDefined();
    expect(f.revoked).toHaveLength(1);
    expect(f.minted.size).toBe(0);
    expect(f.credentials.isOpen()).toBe(false);
  });

  it('does not invoke bootstrap creation after cleanup races its pre-create receipt', async () => {
    const f = credentialFixture(); let creates = 0;
    f.hooks.sync = count => { if (count === 1) f.credentials.close(); };
    await expect(f.credentials.bootstrap('repo', async () => { creates++; return { name: 'repo', remote: 'http://fixture/repo.git', defaultBranch: 'main' }; })).rejects.toBeDefined();
    expect(creates).toBe(0);
  });

  it('keeps lost mint responses uncertain after project expiry', async () => {
    const f = credentialFixture();
    f.hooks.mint = async () => { throw new Error('fixture: response lost after possible provider mint'); };
    await expect(f.credentials.issue('repo', 'read', 'canonical-read', 'operator')).rejects.toMatchObject({ code: 'credential_issuance_uncertain' });
    const lifetime = f.credentials.lifetime()!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(lifetime.expiresAt) + 60_000);
    f.credentials.enforce(); await f.credentials.sweep(true);
    expect(f.credentials.status()).toMatchObject({ complete: false, unknownIssuance: 1 });
    expect(f.credentials.records()[0]).toMatchObject({ id: null, expiresAt: null, status: 'unknown' });
  });

  it('compensates a failed ID write and recovers revoke debt across manager restart', async () => {
    const f = credentialFixture();
    f.hooks.put = (table, value) => { if (table === 'credentials' && value.id) throw new Error('fixture SQL write failure'); };
    f.hooks.revoke = async () => { throw new Error('fixture provider revoke failure'); };
    await expect(f.credentials.issue('repo', 'write', 'fork-write', 'fixture-agent')).rejects.toMatchObject({ code: 'credential_tracking_failed' });
    expect(f.revoked).toHaveLength(1); expect(f.minted.size).toBe(1); expect(f.debt.size).toBe(1);
    for (const secret of f.minted.values()) expect(JSON.stringify([...f.debt.values()])).not.toContain(secret);
    f.hooks.put = undefined; f.hooks.revoke = undefined;
    const restarted = new DemoCredentials(f.fixtureEnv, f.store); restarted.close(); await restarted.sweep(true);
    expect(f.minted.size).toBe(0); expect(f.debt.size).toBe(0); expect(restarted.status().complete).toBe(true);
  });

  it('never releases a credential whose provider expiry exceeds project expiry', async () => {
    const f = credentialFixture();
    f.hooks.mint = async () => {
      const id = 'overlong-fixture', plaintext = 'fixture-overlong-secret'; f.minted.set(id, plaintext);
      return { id, plaintext, expiresAt: new Date(Date.parse(f.credentials.lifetime()!.expiresAt) + 60_000).toISOString() };
    };
    await expect(f.credentials.issue('repo', 'write', 'fork-write', 'fixture-agent')).rejects.toMatchObject({ code: 'invalid_provider_credential' });
    expect(f.minted.size).toBe(0); expect(f.revoked).toEqual(['overlong-fixture']);
  });

  it('does not call a provider after fewer than sixty seconds remain', async () => {
    const f = credentialFixture(); let calls = 0;
    f.store.put('meta', 'credentialLifetime', { ...f.credentials.lifetime(), expiresAt: new Date(Date.now() + 59_000).toISOString() });
    f.hooks.mint = async () => { calls++; throw new Error('must not be called'); };
    await expect(f.credentials.issue('repo', 'read', 'canonical-read', 'operator')).rejects.toMatchObject({ code: 'credential_window_ending' });
    expect(calls).toBe(0);
  });
});

  // This receipt models process loss while provider work is still outstanding.
  // Its unknown expiry must survive independently of the later JS catch path.
  it('cannot expire a pre-create receipt whose provider response never reached the process', async () => {
    const f = credentialFixture(); let release!: (token: RepoToken) => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.hooks.mint = async () => { started(); return new Promise<RepoToken>(resolve => { release = resolve; }); };
    const issuance = f.credentials.issue('repo', 'read', 'canonical-read', 'operator');
    await ready;
    const original = f.credentials.lifetime()!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(original.expiresAt) + 60_000);
    const restarted = new DemoCredentials(f.fixtureEnv, f.store); restarted.close(); await restarted.sweep(true);
    expect(restarted.status()).toMatchObject({ complete: false, unknownIssuance: 1 });
    expect(restarted.records()[0]).toMatchObject({ id: null, expiresAt: null });
    release({ id: 'late-response-id', plaintext: 'fixture-late-secret', expiresAt: original.expiresAt });
    await expect(issuance).rejects.toBeDefined();
  });

describe('independent credential control-plane adversarial review', () => {
  it('separates operator cleanup/status privileges and retains readable proof after closure', async () => {
    const f = await projectFixture();
    for (const token of [null, f.joined.agentKey]) {
      expect((await api(`${f.base}/credentials`, undefined, token)).status).toBe(403);
      expect((await api(`${f.base}/cleanup`, {}, token)).status).toBe(403);
    }
    expect((await api(`${f.base}/agents/fixture-agent/token`, {}, operator)).status).toBe(403);
    const before = await ok(`${f.base}/credentials`);
    expect(before.open).toBe(true); expect(before.complete).toBe(false);
    expect(Date.parse(before.lifetime.expiresAt) - Date.parse(before.lifetime.createdAt)).toBeLessThanOrEqual(3_600_000);
    const cleanup = await ok(`${f.base}/cleanup`, {});
    expect(cleanup).toMatchObject({ open: false, complete: true, outstanding: 0 });
    expect((await api(f.base, undefined, f.joined.agentKey)).status).toBe(403);
    expect((await api(`${f.base}/agents/fixture-agent/token`, {}, f.joined.agentKey)).status).toBe(403);
    expect((await api(`${f.base}/tasks`, { slug: 'closed-task', intent: 'must remain closed' })).status).toBe(410);
    const board = await ok(f.base); expect(board.tasks).toHaveLength(1); expect(board.agents).toHaveLength(1);
    const serialized = JSON.stringify({ cleanup, before, board });
    for (const secret of [f.created.readToken, f.joined.agentKey, f.joined.fork.token, f.joined.upstream.readToken]) expect(serialized).not.toContain(secret);
    await runInDurableObject(f.project, instance => {
      expect(instance.store.rows<any>('SELECT keyHash,keyExpiresAt FROM agents')).toEqual([{ keyHash: null, keyExpiresAt: null }]);
      expect(instance.store.get('meta', 'stateGeneration')).toBeGreaterThan(0);
    });
  });

  it('fails closed for legacy agent keys with no expiry', async () => {
    const f = await projectFixture();
    await runInDurableObject(f.project, instance => instance.store.storage.sql.exec('UPDATE agents SET keyExpiresAt=NULL'));
    expect((await api(f.base, undefined, f.joined.agentKey)).status).toBe(403);
    expect((await api(`${f.base}/agents/fixture-agent/token`, {}, f.joined.agentKey)).status).toBe(403);
    expect((await api(f.base)).status).toBe(200);
    await ok(`${f.base}/cleanup`, {});
  });

  it('retains provider revocation failures as debt and retries them after restart', async () => {
    const f = await projectFixture(), originalGet = memoryArtifacts.get.bind(memoryArtifacts);
    const secrets = [...memoryArtifacts.repos.get(f.id)!.tokens.values()];
    const spy = vi.spyOn(memoryArtifacts, 'get').mockImplementation(async name => {
      const repo = await originalGet(name);
      return name === f.id ? { ...repo, async revokeToken() { throw new Error(`fixture provider failure ${secrets[0]}`); } } : repo;
    });
    const response = await api(`${f.base}/cleanup`, {}), failed = await response.json() as any;
    expect(response.status).toBe(202); expect(failed.complete).toBe(false); expect(failed.revocationPending).toBeGreaterThan(0);
    for (const secret of secrets) expect(JSON.stringify(failed)).not.toContain(secret);
    spy.mockRestore();
    await evictDurableObject(f.project);
    const completed = await ok(`${f.base}/cleanup`, {});
    expect(completed).toMatchObject({ complete: true, outstanding: 0 });
    expect(memoryArtifacts.repos.get(f.id)!.tokens.size).toBe(0);
  });

  it('admits uncertainty for legacy canonical credentials missing from the ledger', async () => {
    const f = await projectFixture();
    await runInDurableObject(f.project, instance => {
      instance.store.storage.sql.exec("DELETE FROM meta WHERE key='credentialLifetime'");
      instance.store.storage.sql.exec('DELETE FROM credentials');
    });
    const response = await api(`${f.base}/cleanup`, {}), result = await response.json() as any;
    expect(response.status).toBe(202);
    expect(result).toMatchObject({ complete: false, legacyInventoryUnknown: true, open: false });
    expect(memoryArtifacts.repos.get(f.id)!.tokens.size).toBeGreaterThan(0);
    expect((await api(f.base, undefined, f.joined.agentKey)).status).toBe(403);
  });

  it('fences pending journal replay, event pushes and alarms after cleanup', async () => {
    const f = await projectFixture();
    await runInDurableObject(f.project, instance => {
      instance.store.storage.sql.exec("INSERT INTO ops(id,command,input,context,status) VALUES(?,?,?,?, 'pending')", 'review-pending-task', 'task.create', JSON.stringify({ opId: 'review-pending-task', task: 'blocked', intent: 'do not replay after cleanup' }), '{}');
    });
    await ok(`${f.base}/cleanup`, {});
    const before = (await f.engine.stats()).calls.length;
    expect(await f.project.notePush(`${f.id}--test-task--fixture-agent`, 'refs/heads/main', sha(999), 'event')).toBe(false);
    await runInDurableObject(f.project, instance => instance.alarm());
    await evictDurableObject(f.project);
    await ok(f.base); await new Promise(resolve => setTimeout(resolve, 50));
    expect((await f.engine.stats()).calls).toHaveLength(before);
    await runInDurableObject(f.project, instance => expect(instance.store.rows<any>("SELECT status FROM ops WHERE id='review-pending-task'")).toEqual([{ status: 'pending' }]));
  });

  it('closes access immediately while a native command is still in progress', async () => {
    const f = await projectFixture();
    const originalGeneration = await runInDurableObject(f.project, instance => instance.store.get('meta', 'stateGeneration'));
    await f.engine.delayNext('ingest', 1000);
    await f.project.notePush(`${f.id}--test-task--fixture-agent`, 'refs/heads/main', sha(1001), 'event');
    for (let i = 0; i < 100; i++) {
      if ((await f.engine.stats()).calls.some((call: any) => call.command === 'ingest')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const start = Date.now(), response = await api(`${f.base}/cleanup`, {});
    expect([200, 202]).toContain(response.status);
    expect(Date.now() - start).toBeLessThan(700);
    expect((await api(f.base, undefined, f.joined.agentKey)).status).toBe(403);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect((await f.engine.stats()).calls.filter((call: any) => call.command === 'ingest')).toHaveLength(1);
    await runInDurableObject(f.project, instance => {
      expect(instance.store.get('meta', 'stateGeneration')).toBe(originalGeneration);
      expect(instance.store.all('candidates')).toHaveLength(0);
    });
    expect((await ok(`${f.base}/cleanup`, {})).complete).toBe(true);
  });

  it('does not return an in-flight native read to an agent after cleanup revokes it', async () => {
    const f = await projectFixture();
    await f.engine.delayNext('why', 500);
    const read = api(`${f.base}/why/${sha(77)}`, undefined, f.joined.agentKey);
    for (let i = 0; i < 100; i++) {
      if ((await f.engine.stats()).calls.some((call: any) => call.command === 'why')) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await ok(`${f.base}/cleanup`, {});
    expect((await read).status).toBe(403);
  });

  it('closes an idle WebSocket at expiry even while the native writer queue is occupied', async () => {
    const f = await projectFixture();
    const response = await SELF.fetch(`https://heddle.test${f.base}/ws`, { headers: { authorization: `Bearer ${f.joined.agentKey}`, upgrade: 'websocket' } });
    expect(response.status).toBe(101); const socket = response.webSocket!; socket.accept();
    const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)));
    await f.engine.delayNext('ingest', 1000);
    await f.project.notePush(`${f.id}--test-task--fixture-agent`, 'refs/heads/main', sha(1002), 'event');
    for (let i = 0; i < 100; i++) {
      if ((await f.engine.stats()).calls.some((call: any) => call.command === 'ingest')) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await runInDurableObject(f.project, async (instance, state) => {
      const lifetime = instance.credentials.lifetime()!;
      instance.store.put('meta', 'credentialLifetime', { ...lifetime, expiresAt: new Date(Date.now() + 50).toISOString() });
      await state.storage.setAlarm(Date.now() + 60);
    });
    expect(await Promise.race([closed, new Promise<string>(resolve => setTimeout(() => resolve('expiry-close-timeout'), 600))])).toBe(1008);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await ok(`${f.base}/cleanup`, {});
  });
});

it('does not claim clean inventory after adopting an existing repository with hidden tokens', async () => {
  const id = `adopted-${crypto.randomUUID().slice(0, 8)}`, base = `/api/projects/${id}`;
  await memoryArtifacts.create(id);
  using existing = await memoryArtifacts.get(id);
  const hidden = await existing.createToken('read', 3600);
  const response = await api('/api/projects', { id, seed: { template: 'demo' } });
  expect(response.status).toBe(200);
  const cleanup = await api(`${base}/cleanup`, {}), result = await cleanup.json() as any;
  expect(cleanup.status).toBe(202); expect(result.complete).toBe(false);
  expect(memoryArtifacts.repos.get(id)!.tokens.has(hidden.id)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(hidden.plaintext);
});

it('does not regress confirmed revocation when concurrent cleanup receives an already-absent result', async () => {
  const f = credentialFixture(), token = await f.credentials.issue('repo', 'read', 'canonical-read', 'operator');
  f.credentials.close();
  const concurrent = new DemoCredentials(f.fixtureEnv, f.store);
  await Promise.all([f.credentials.revoke('repo', token.id), concurrent.revoke('repo', token.id)]);
  expect(f.minted.size).toBe(0);
  expect(f.credentials.records().find(record => record.id === token.id)?.status).toBe('revoked');
  expect(f.credentials.status().complete).toBe(true);
});

it('gives every credential a revoke attempt despite an earlier batch of persistent failures', async () => {
  const f = credentialFixture();
  const expiry = f.credentials.lifetime()!.expiresAt;
  for (let i = 0; i < 101; i++) {
    f.store.put('credentials', `receipt-${i}`, { receipt: `receipt-${i}`, id: `id-${i}`, repo: 'repo', owner: 'fixture', type: 'engine-read', createdAt: new Date().toISOString(), expiresAt: expiry, status: 'active', attempts: 0 });
  }
  f.hooks.revoke = async () => false;
  f.credentials.close(); await f.credentials.sweep(true); await f.credentials.sweep(true);
  expect(f.revoked).toContain('id-100');
  expect(f.credentials.status().complete).toBe(false);
});

it('does not persist a malformed provider ID that is actually the bearer itself', async () => {
  const f = credentialFixture(), bearer = 'fixture-confused-id-and-bearer';
  f.hooks.mint = async () => {
    f.minted.set(bearer, bearer);
    return { id: bearer, plaintext: bearer, expiresAt: f.credentials.lifetime()!.expiresAt };
  };
  await expect(f.credentials.issue('repo', 'read', 'canonical-read', 'operator')).rejects.toBeDefined();
  expect(f.minted.size).toBe(0);
  expect(JSON.stringify(f.credentials.records())).not.toContain(bearer);
  expect(JSON.stringify(f.credentials.status())).not.toContain(bearer);
});
