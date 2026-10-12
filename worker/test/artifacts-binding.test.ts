// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF, env as testEnv, runInDurableObject } from 'cloudflare:test';
import type { ArtifactsBinding, ArtifactsRepo, Env, RepoInfo } from '../env';
import { artifacts, existingRepository, ARTIFACTS_CALL_MS } from '../artifacts';
import { memoryArtifacts } from '../../dev/memory-artifacts';

const env = testEnv as unknown as Env;
const sha = (n: number) => n.toString(16).padStart(40, '0');
const providerError = (code: string, numericCode: number) => Object.assign(new Error('Private provider diagnostic'), { name: 'ArtifactsError', code, numericCode });
const notFound = () => providerError('NOT_FOUND', 10200);
async function api(path: string, body?: unknown) {
  return SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer test-operator', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function ok(path: string, body?: unknown) {
  const response = await api(path, body), data = await response.json() as any;
  expect(response.status, JSON.stringify(data)).toBe(200); return data;
}
const projectId = () => `binding-${crypto.randomUUID().slice(0, 8)}`;
async function setup() {
  const id = projectId(), base = `/api/projects/${id}`;
  await ok('/api/projects', { id, seed: { template: 'demo' } });
  await ok(`${base}/tasks`, { slug: 'task', intent: 'Provider binding regression' });
  return { id, base, stub: env.PROJECT.getByName(id) };
}
function failProbe(target: string, stage: 'get' | 'info', error: Error | { value: unknown }) {
  const originalGet = memoryArtifacts.get.bind(memoryArtifacts), calls = { mints: 0, forks: 0 };
  const creates = vi.spyOn(memoryArtifacts, 'create');
  vi.spyOn(memoryArtifacts, 'get').mockImplementation(async name => {
    if (name === target && stage === 'get') throw error;
    const repo = await originalGet(name);
    return { ...repo,
      info: async () => { if (name === target && stage === 'info') { if (error instanceof Error) throw error; return error.value as RepoInfo; } return repo.info(); },
      createToken: async (scope, ttl) => { calls.mints++; return repo.createToken(scope, ttl); },
      fork: async (name, options) => { calls.forks++; return repo.fork(name, options); },
    };
  });
  return { creates, calls };
}
afterEach(() => vi.restoreAllMocks());

describe('provider Artifacts binding contract', () => {
  it('poll alone consumes official hash metadata and duplicate polls capture once', async () => {
    const { id, base, stub } = await setup();
    await ok(`${base}/tasks/task/agents`, { id: 'alice', kind: 'agent', displayName: 'Alice' });
    const fork = `${id}--task--alice`;
    memoryArtifacts.repos.get(fork)!.tip = sha(712);
    using repo = await memoryArtifacts.get(fork);
    const [tip] = await repo.log({ ref: 'main', limit: 1 });
    expect(tip).toMatchObject({ hash: sha(712), authoredAt: expect.any(Number), committedAt: expect.any(Number) });
    expect(tip).not.toHaveProperty('id'); expect(tip).not.toHaveProperty('timestamp');
    await stub.poll(); await stub.poll();
    let task: any;
    for (let i = 0; i < 100; i++) {
      task = await ok(`${base}/tasks/task`);
      if (task.candidates.length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(task.candidates).toHaveLength(1); expect(task.candidates[0].sourceSha).toBe(sha(712));
    await stub.poll();
    await runInDurableObject(stub, instance => {
      expect(instance.store.rows('SELECT * FROM pushes')).toHaveLength(1);
      expect(instance.store.rows("SELECT * FROM ops WHERE command='ingest' AND status='done'")).toHaveLength(1);
    });
  });

  // The installed provider type documents CREATE_IN_PROGRESS but the current
  // public numeric-code table omits it. -1 is deliberately a fixture sentinel.
  const failures = [['INTERNAL_ERROR', 10400], ['IMPORT_IN_PROGRESS', 10302], ['FORK_IN_PROGRESS', 10303], ['CREATE_IN_PROGRESS', -1]] as const;
  for (const stage of ['get', 'info'] as const) {
    for (const [code, numericCode] of failures) {
      it(`canonical ${stage} ${code} never creates, mints or closes; retry can succeed`, async () => {
        const id = projectId(), stub = env.PROJECT.getByName(id);
        if (stage === 'info') await memoryArtifacts.create(id);
        const tokensBefore = [...(memoryArtifacts.repos.get(id)?.tokens ?? [])];
        const { creates, calls } = failProbe(id, stage, providerError(code, numericCode));
        const response = await api('/api/projects', { id, seed: { template: 'demo' } });
        expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'artifacts_unavailable' });
        expect(creates).not.toHaveBeenCalled(); expect(calls).toEqual({ mints: 0, forks: 0 });
        expect([...(memoryArtifacts.repos.get(id)?.tokens ?? [])]).toEqual(tokensBefore);
        await runInDurableObject(stub, instance => {
          expect(instance.credentials.isOpen()).toBe(true); expect(instance.credentials.lifetime()).not.toHaveProperty('closedAt');
          expect(instance.credentials.records()).toEqual([]); expect(instance.store.get('meta', 'project')).toBeUndefined();
        });
        vi.restoreAllMocks();
        await ok('/api/projects', { id, seed: { template: 'demo' } });
      });
      it(`fork ${stage} ${code} never enrolls, forks, mints or closes; retry can succeed`, async () => {
        const { id, base, stub } = await setup(), target = `${id}--task--alice`;
        if (stage === 'info') await memoryArtifacts.create(target);
        const recordsBefore = await runInDurableObject(stub, instance => instance.credentials.records());
        const tokensBefore = [...memoryArtifacts.repos].filter(([name]) => name === id || name === target).map(([name, data]) => [name, [...data.tokens]]);
        const { creates, calls } = failProbe(target, stage, providerError(code, numericCode));
        const response = await api(`${base}/tasks/task/agents`, { id: 'alice', kind: 'agent', displayName: 'Alice' });
        expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'artifacts_unavailable' });
        expect(creates).not.toHaveBeenCalled(); expect(calls).toEqual({ mints: 0, forks: 0 });
        expect([...memoryArtifacts.repos].filter(([name]) => name === id || name === target).map(([name, data]) => [name, [...data.tokens]])).toEqual(tokensBefore);
        await runInDurableObject(stub, instance => {
          expect(instance.credentials.isOpen()).toBe(true); expect(instance.credentials.lifetime()).not.toHaveProperty('closedAt');
          expect(instance.credentials.records()).toEqual(recordsBefore);
          expect(instance.store.all('agents')).toEqual([]); expect(instance.store.all('lanes')).toEqual([]);
          expect(instance.store.rows("SELECT * FROM ops WHERE command='agent.enroll'")).toEqual([]);
        });
        vi.restoreAllMocks();
        await ok(`${base}/tasks/task/agents`, { id: 'alice', kind: 'agent', displayName: 'Alice' });
      });
    }
    it(`only a full provider NOT_FOUND from ${stage} proves absence`, async () => {
      const rejected = [new Error('NOT_FOUND'), Object.assign(new Error('missing'), { code: 'NOT_FOUND' }), Object.assign(new Error('missing'), { name: 'ArtifactsError', code: 'NOT_FOUND', numericCode: 404 }), Object.assign(new Error('missing'), { name: 'OtherError', code: 'NOT_FOUND', numericCode: 10200 })];
      let disposed = 0;
      for (const error of [notFound(), ...rejected]) {
        const binding = { async get() { if (stage === 'get') throw error; return { [Symbol.dispose]() { disposed++; }, async info() { throw error; } }; } } as unknown as ArtifactsBinding;
        const probe = existingRepository({ ...env, DEV: '0', ARTIFACTS: binding }, 'repo');
        if (rejected.includes(error)) await expect(probe).rejects.toMatchObject({ code: 'artifacts_unavailable', status: 503 });
        else expect(await probe).toBeUndefined();
      }
      expect(disposed).toBe(stage === 'info' ? 5 : 0);
    });
    it(`provider NOT_FOUND from canonical ${stage} permits create and bootstrap revocation`, async () => {
      const id = projectId(), originalGet = memoryArtifacts.get.bind(memoryArtifacts); let probe = true;
      vi.spyOn(memoryArtifacts, 'get').mockImplementation(async name => {
        if (name === id && probe) {
          probe = false;
          if (stage === 'get') throw notFound();
          return { [Symbol.dispose]() {}, async info() { throw notFound(); } } as unknown as ArtifactsRepo;
        }
        return originalGet(name);
      });
      const creates = vi.spyOn(memoryArtifacts, 'create');
      await ok('/api/projects', { id, seed: { template: 'demo' } });
      expect(creates).toHaveBeenCalledTimes(1);
      await runInDurableObject(env.PROJECT.getByName(id), instance => expect(instance.credentials.records().filter(row => row.type === 'bootstrap')).toEqual([expect.objectContaining({ status: 'revoked' })]));
      expect(memoryArtifacts.repos.get(id)!.tokens.size).toBe(1);
    });
    it(`provider NOT_FOUND from fork ${stage} permits one fork and bootstrap revocation`, async () => {
      const { id, base, stub } = await setup(), target = `${id}--task--alice`, originalGet = memoryArtifacts.get.bind(memoryArtifacts); let probe = true;
      vi.spyOn(memoryArtifacts, 'get').mockImplementation(async name => {
        if (name === target && probe) {
          probe = false;
          if (stage === 'get') throw notFound();
          return { [Symbol.dispose]() {}, async info() { throw notFound(); } } as unknown as ArtifactsRepo;
        }
        return originalGet(name);
      });
      const creates = vi.spyOn(memoryArtifacts, 'create');
      await ok(`${base}/tasks/task/agents`, { id: 'alice', kind: 'agent', displayName: 'Alice' });
      expect(creates).toHaveBeenCalledExactlyOnceWith(target);
      await runInDurableObject(stub, instance => expect(instance.credentials.records().filter(row => row.type === 'bootstrap' && row.repo === target)).toEqual([expect.objectContaining({ status: 'revoked' })]));
      expect(memoryArtifacts.repos.get(target)!.tokens.size).toBe(1);
    });
  }
  const invalidMetadata: Array<[string, (name: string) => unknown]> = [
    ['null', () => null], ['undefined', () => undefined], ['array', () => []], ['empty object', () => ({})],
    ['mismatched name', () => ({ name: 'other-repository', remote: 'https://fixture.invalid/repo.git', defaultBranch: 'main' })],
    ['missing name', () => ({ remote: 'https://fixture.invalid/repo.git', defaultBranch: 'main' })],
    ['non-string remote', name => ({ name, remote: 42, defaultBranch: 'main' })],
    ['empty remote', name => ({ name, remote: '', defaultBranch: 'main' })],
    ['missing remote', name => ({ name, defaultBranch: 'main' })],
    ['non-string branch', name => ({ name, remote: 'https://fixture.invalid/repo.git', defaultBranch: null })],
    ['empty branch', name => ({ name, remote: 'https://fixture.invalid/repo.git', defaultBranch: ' ' })],
    ['missing branch', name => ({ name, remote: 'https://fixture.invalid/repo.git' })],
  ];
  for (const [label, metadata] of invalidMetadata) {
    it(`canonical info success with ${label} cannot create, mint or close`, async () => {
      const id = projectId(), stub = env.PROJECT.getByName(id);
      await memoryArtifacts.create(id);
      const tokensBefore = [...memoryArtifacts.repos.get(id)!.tokens];
      const { creates, calls } = failProbe(id, 'info', { value: metadata(id) });
      const response = await api('/api/projects', { id, seed: { template: 'demo' } });
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'artifacts_unavailable' });
      expect(creates).not.toHaveBeenCalled(); expect(calls).toEqual({ mints: 0, forks: 0 });
      expect([...memoryArtifacts.repos.get(id)!.tokens]).toEqual(tokensBefore);
      await runInDurableObject(stub, instance => {
        expect(instance.credentials.isOpen()).toBe(true); expect(instance.credentials.records()).toEqual([]);
        expect(instance.store.get('meta', 'project')).toBeUndefined(); expect(instance.store.all('agents')).toEqual([]);
      });
    });
    it(`fork info success with ${label} cannot enroll, fork, mint or close`, async () => {
      const { id, base, stub } = await setup(), target = `${id}--task--alice`;
      await memoryArtifacts.create(target);
      const recordsBefore = await runInDurableObject(stub, instance => instance.credentials.records());
      const tokensBefore = [...memoryArtifacts.repos].filter(([name]) => name === id || name === target).map(([name, data]) => [name, [...data.tokens]]);
      const { creates, calls } = failProbe(target, 'info', { value: metadata(target) });
      const response = await api(`${base}/tasks/task/agents`, { id: 'alice', kind: 'agent', displayName: 'Alice' });
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'artifacts_unavailable' });
      expect(creates).not.toHaveBeenCalled(); expect(calls).toEqual({ mints: 0, forks: 0 });
      expect([...memoryArtifacts.repos].filter(([name]) => name === id || name === target).map(([name, data]) => [name, [...data.tokens]])).toEqual(tokensBefore);
      await runInDurableObject(stub, instance => {
        expect(instance.credentials.isOpen()).toBe(true); expect(instance.credentials.records()).toEqual(recordsBefore);
        expect(instance.store.all('agents')).toEqual([]); expect(instance.store.all('lanes')).toEqual([]);
        expect(instance.store.rows("SELECT * FROM ops WHERE command='agent.enroll'")).toEqual([]);
      });
    });
  }
  it('valid provider info permits non-main default branches and additional metadata', async () => {
    const info = { name: 'repo', remote: 'https://fixture.invalid/repo.git', defaultBranch: 'feature/provider-default', id: 'provider-repo-id', description: null };
    let disposed = false;
    const binding = { async get() { return { [Symbol.dispose]() { disposed = true; }, async info() { return info; } }; } } as unknown as ArtifactsBinding;
    expect(await existingRepository({ ...env, DEV: '0', ARTIFACTS: binding }, 'repo')).toEqual(info);
    expect(disposed).toBe(true);
  });
  it('DEV adapter preserves structured binding errors and never interprets a generic HTTP 404 as absence', async () => {
    const dev = { ...env, DEV: '1', FAKE_ARTIFACTS_URL: 'http://fixture.invalid' };
    for (const [code, numericCode] of [['NOT_FOUND', 10200], ['INTERNAL_ERROR', 10400], ['IMPORT_IN_PROGRESS', 10302], ['FORK_IN_PROGRESS', 10303]] as const) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ error: { name: 'ArtifactsError', code, numericCode } }, { status: 503 }));
      await expect(artifacts(dev).get('repo')).rejects.toMatchObject({ name: 'ArtifactsError', code, numericCode });
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(existingRepository(dev, 'repo')).rejects.toMatchObject({ status: 503, code: 'artifacts_unavailable' });
  });
});

it('a hung Artifacts provider call fails with artifacts_timeout instead of blocking the project queue', async () => {
  vi.useFakeTimers();
  try {
    const never = new Promise<never>(() => {});
    const hungRepo = { info: () => never, fork: () => never, createToken: () => never, revokeToken: () => never, log: () => never, [Symbol.dispose]() {} };
    const binding = artifacts({ DEV: '0', ARTIFACTS: { create: () => never, get: async () => hungRepo } } as unknown as Env);
    const repo = await binding.get('fork');
    for (const start of [() => repo.log({ ref: 'main', limit: 1 }), () => repo.revokeToken('t'), () => binding.create('x')]) {
      const settled = expect(start()).rejects.toMatchObject({ name: 'DeadlineError', code: 'artifacts_timeout' });
      await vi.advanceTimersByTimeAsync(ARTIFACTS_CALL_MS + 1);
      await settled;
    }
  } finally { vi.useRealTimers(); }
});
