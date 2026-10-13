// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { SELF, env as testEnv, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import type { ArtifactsBinding, ArtifactsRepo, Env, RepoToken } from '../env';
import { DemoCredentials, demoTtl, type CredentialRecord } from '../credentials';
import { memoryArtifacts } from '../../dev/memory-artifacts';
const env = testEnv as unknown as Env;
async function api(path: string, body?: unknown, token = 'test-operator') {
  return SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function fixture() {
  const id = `credentials-${crypto.randomUUID().slice(0, 8)}`;
  const response = await api('/api/projects', { id, seed: { template: 'demo' } });
  expect(response.status).toBe(200);
  return { id, base: `/api/projects/${id}`, stub: env.PROJECT.getByName(id), creation: await response.json() as any };
}
function binding(get: (repo: ArtifactsRepo) => ArtifactsRepo): ArtifactsBinding {
  return { create: name => memoryArtifacts.create(name), async get(name) { return get(await memoryArtifacts.get(name)); } };
}
function testCredentials(instance: any, value: ArtifactsBinding) { return new DemoCredentials({ ...env, ARTIFACTS: value, DEV: '0' }, instance.store); }

describe('bounded demo credential ledger', () => {
  it('validates the operator TTL hard ceiling and persists no plaintext for all seven app credentials', async () => {
    expect(demoTtl({})).toBe(3600);
    for (const value of ['120', '300', '3600']) expect(demoTtl({ DEMO_CREDENTIAL_TTL_SECONDS: value })).toBe(Number(value));
    for (const value of ['', '0', '59', '60', '61', '119', '7201', '3600.0', '-1', 'NaN', ' 3600', '1e3']) expect(() => demoTtl({ DEMO_CREDENTIAL_TTL_SECONDS: value })).toThrow('invalid_demo_credential_ttl');
    const { id, base, stub, creation } = await fixture();
    expect(Date.parse(creation.expiresAt)).toBeLessThanOrEqual(Date.parse(creation.projectExpiresAt));
    expect(Date.parse(creation.projectExpiresAt) - Date.now()).toBeLessThanOrEqual(3600000);
    expect((await api(`${base}/tasks`, { slug: 'demo-task', intent: 'credentials fixture' })).status).toBe(200);
    const secrets = [creation.readToken];
    for (const name of ['alice', 'bob', 'carol']) {
      const response = await api(`${base}/tasks/demo-task/agents`, { id: name, kind: 'agent', displayName: name });
      expect(response.status).toBe(200); const body = await response.json() as any;
      expect(body.agentKeyExpiresAt).toBe(creation.projectExpiresAt);
      expect(Date.parse(body.upstream.expiresAt)).toBeLessThanOrEqual(Date.parse(creation.projectExpiresAt));
      secrets.push(body.agentKey, body.upstream.readToken, body.fork.token);
    }
    await runInDurableObject(stub, instance => {
      const records = instance.credentials.records();
      expect(records.filter(r => r.status === 'active')).toHaveLength(7);
      expect(records.filter(r => r.status === 'active' && r.type === 'canonical-read')).toHaveLength(4);
      for (const tokenId of memoryArtifacts.repos.get(id)!.tokens.keys()) expect(records.some(r => r.id === tokenId)).toBe(true);
      const durable = JSON.stringify({ records, agents: instance.store.rows<any>('SELECT * FROM agents'), meta: instance.store.all('meta'), ops: instance.store.rows<any>('SELECT * FROM ops') });
      for (const secret of secrets) expect(durable).not.toContain(secret);
      expect(records.filter(r => r.type.startsWith('engine-')).every(r => r.status === 'revoked')).toBe(true);
    });
    expect((await api(`${base}/cleanup`, {})).status).toBe(200);
  });

  it('immediately revokes a known token when durable tracking fails and never returns plaintext', async () => {
    const { id, stub, base } = await fixture();
    await runInDurableObject(stub, async instance => {
      const original = instance.store.put.bind(instance.store); let issued: RepoToken | undefined;
      const credentials = testCredentials(instance, binding(repo => ({ ...repo, async createToken(scope, ttl) { issued = await repo.createToken(scope, ttl); return issued; } })));
      instance.store.put = (table: string, key: string, value: any) => { if (table === 'credentials' && value.status === 'active') throw new Error('fixture ledger unavailable'); original(table, key, value); };
      try { await expect(credentials.issue(id, 'read', 'canonical-read', 'operator')).rejects.toMatchObject({ code: 'credential_tracking_failed' }); }
      finally { instance.store.put = original; }
      expect(issued).toBeDefined(); expect(memoryArtifacts.repos.get(id)!.tokens.has(issued!.id)).toBe(false);
      expect(credentials.records().find(r => r.id === issued!.id)?.status).toBe('revoked');
      expect(JSON.stringify(credentials.records())).not.toContain(issued!.plaintext);
    });
    await api(`${base}/cleanup`, {});
  });

  it('preserves compensating revoke debt through independent storage and replays it after restart', async () => {
    const { id, stub, base } = await fixture(); let tokenId = '';
    await runInDurableObject(stub, async instance => {
      const original = instance.store.put.bind(instance.store); let issued: RepoToken | undefined;
      const credentials = testCredentials(instance, binding(repo => ({ ...repo, async createToken(scope, ttl) { issued = await repo.createToken(scope, ttl); return issued; }, async revokeToken() { throw new Error('private fixture error must not be retained'); } })));
      instance.store.put = (table: string, key: string, value: any) => { if (table === 'credentials' && value.id) throw new Error('fixture ledger unavailable'); original(table, key, value); };
      try { await expect(credentials.issue(id, 'write', 'fork-write', 'alice')).rejects.toMatchObject({ code: 'credential_tracking_failed' }); }
      finally { instance.store.put = original; }
      tokenId = issued!.id;
      const debts = await instance.store.storage.list<CredentialRecord>({ prefix: 'credential-debt:' });
      expect(debts.size).toBe(1); const debt = [...debts.values()][0];
      expect(debt).toMatchObject({ id: tokenId, status: 'revoke-pending', uncertainty: 'tracking-failed' });
      expect(JSON.stringify(debt)).not.toContain(issued!.plaintext); expect(JSON.stringify(debt)).not.toContain('private fixture');
    });
    await evictDurableObject(stub);
    const response = await api(`${base}/cleanup`, {}); expect(response.status).toBe(200);
    await runInDurableObject(stub, async instance => {
      expect(instance.credentials.records().find(r => r.id === tokenId)?.status).toBe('revoked');
      expect((await instance.store.storage.list({ prefix: 'credential-debt:' })).size).toBe(0);
    });
    expect(memoryArtifacts.repos.get(id)!.tokens.has(tokenId)).toBe(false);
  });

  it('retains unknown issuance without an invented expiry even when the project expires', async () => {
    const { id, stub, base } = await fixture();
    await runInDurableObject(stub, async instance => {
      const credentials = testCredentials(instance, binding(repo => ({ ...repo, async createToken(scope, ttl) { await repo.createToken(scope, ttl); throw new Error('response lost'); } })));
      await expect(credentials.issue(id, 'read', 'canonical-read', 'operator')).rejects.toMatchObject({ code: 'credential_issuance_uncertain' });
      const unknown = credentials.records().find(r => r.status === 'unknown')!;
      expect(unknown.id).toBeNull(); expect(unknown.expiresAt).toBeNull();
      // A process death can leave an earlier 'issuing' receipt too.
      instance.store.put('credentials', 'interrupted-create', { ...unknown, receipt: 'interrupted-create', status: 'issuing' });
      credentials.close(); await credentials.sweep(true);
      expect(credentials.status()).toMatchObject({ complete: false, unknownIssuance: 2 });
    });
    const response = await api(`${base}/cleanup`, {}); expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ complete: false, unknownIssuance: 2 });
  });

  it('cold recovery closes a project with an interrupted provider issuance before journal replay', async () => {
    const { stub, base } = await fixture();
    await runInDurableObject(stub, instance => {
      instance.store.put('credentials', 'interrupted-before-response', { receipt: 'interrupted-before-response', id: null, repo: 'unknown-provider-target', owner: 'operator', type: 'canonical-read', createdAt: new Date().toISOString(), expiresAt: null, status: 'issuing', attempts: 0, uncertainty: 'create-response' });
      instance.store.storage.sql.exec("INSERT INTO ops (id,command,input,context,status) VALUES (?,?,?,?,'pending')", 'should-not-replay', 'task.create', JSON.stringify({ opId: 'should-not-replay', task: 'not-created', intent: 'must not run' }), '{}');
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      await instance.alarm();
      expect(instance.credentials.status()).toMatchObject({ open: false, complete: false, unknownIssuance: 1 });
      expect(instance.store.get('tasks', 'not-created')).toBeUndefined();
      expect(instance.store.rows<any>("SELECT status FROM ops WHERE id='should-not-replay'")[0].status).toBe('pending');
    });
    expect((await api(`${base}/tasks`, { slug: 'new-task', intent: 'blocked' })).status).toBe(410);
  });

  it('reports false and failed revocations as pending, with explicit provider-expiry fallback', async () => {
    const { id, stub, base } = await fixture();
    await runInDurableObject(stub, async instance => {
      const credentials = testCredentials(instance, binding(repo => ({ ...repo, async revokeToken() { return false; } })));
      const token = await credentials.issue(id, 'read', 'canonical-read', 'operator');
      await credentials.revoke(id, token.id);
      let row = credentials.records().find(r => r.id === token.id)!; expect(row.status).toBe('revoke-pending');
      row = { ...row, expiresAt: new Date(Date.now() - 1).toISOString() }; instance.store.put('credentials', row.receipt, row);
      await credentials.sweep(); expect(credentials.records().find(r => r.id === token.id)?.status).toBe('expired');
      expect(credentials.status()).toMatchObject({ expiredFallback: 1, expiryFallbackAssumesProviderEnforcement: true });
    });
    await api(`${base}/cleanup`, {});
  });

  it('denies provider credentials exceeding the lifetime and compensates before returning', async () => {
    const { id, stub, base } = await fixture();
    await runInDurableObject(stub, async instance => {
      let issued: RepoToken | undefined;
      const credentials = testCredentials(instance, binding(repo => ({ ...repo, async createToken(scope, ttl) { issued = await repo.createToken(scope, ttl); return { ...issued, expiresAt: new Date(Date.now() + 7200000).toISOString() }; } })));
      await expect(credentials.issue(id, 'read', 'canonical-read', 'operator')).rejects.toMatchObject({ code: 'invalid_provider_credential' });
      expect(memoryArtifacts.repos.get(id)!.tokens.has(issued!.id)).toBe(false);
    });
    await api(`${base}/cleanup`, {});
  });

  it('keeps bootstrap uncertainty visible without persisting a bearer or deleting repositories', async () => {
    const { id, stub, base } = await fixture();
    await runInDurableObject(stub, async instance => {
      const plaintext = crypto.randomUUID();
      const credentials = testCredentials(instance, binding(repo => ({ ...repo, async revokeToken() { throw new Error('revocation uncertain'); } })));
      await expect(credentials.bootstrap(id, async () => ({ name: id, remote: 'https://fixture.invalid/repo.git', defaultBranch: 'main', token: plaintext }))).rejects.toMatchObject({ code: 'bootstrap_revocation_pending' });
      expect(credentials.status()).toMatchObject({ open: false, complete: false, unknownIssuance: 1 });
      expect(JSON.stringify(credentials.records())).not.toContain(plaintext);
      expect(credentials.records().find(r => r.status === 'revoke-pending')).toMatchObject({ id: null, expiresAt: null, uncertainty: 'bootstrap-id-unavailable' });
    });
    expect((await api(`${base}/cleanup`, {})).status).toBe(202);
    expect(memoryArtifacts.repos.has(id)).toBe(true);
  });
});
