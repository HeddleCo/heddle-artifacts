// SPDX-License-Identifier: Apache-2.0
// Workers-pool binding fixture. Smart HTTP is tested separately against FakeArtifacts.
import type { ArtifactsBinding, ArtifactsRepo, RepoInfo } from '../worker/env';
export class MemoryArtifacts implements ArtifactsBinding {
  repos = new Map<string, { info: RepoInfo; tip?: string; tokens: Map<string, string>; issued: Array<{ id: string; scope: string; ttl: number }> }>();
  async create(name: string) {
    if (this.repos.has(name)) throw Object.assign(new Error('Repository already exists'), { name: 'ArtifactsError', code: 'ALREADY_EXISTS', numericCode: 10201 });
    const info = { name, remote: `http://artifacts/git/heddle-demo/${name}.git`, defaultBranch: 'main' };
    this.repos.set(name, { info, tokens: new Map(), issued: [] });
    using repo = await this.get(name); const token = await repo.createToken('write', 3600);
    return { ...info, token: token.plaintext };
  }
  async get(name: string): Promise<ArtifactsRepo> {
    const data = this.repos.get(name); if (!data) throw Object.assign(new Error('Repository not found'), { name: 'ArtifactsError', code: 'NOT_FOUND', numericCode: 10200 });
    return { [Symbol.dispose]() {}, info: async () => data.info,
      fork: async (name: string) => { const info = await this.create(name); this.repos.get(name)!.tip = data.tip; return info; },
      createToken: async (scope: string, ttl: number) => { const id = crypto.randomUUID(), plaintext = crypto.randomUUID(); data.tokens.set(id, plaintext); data.issued.push({ id, scope, ttl }); return { id, plaintext, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; },
      revokeToken: async token => { const id = data.tokens.has(token) ? token : [...data.tokens].find(([, plaintext]) => plaintext === token)?.[0]; return id ? data.tokens.delete(id) : false; },
      log: async () => data.tip ? [{ hash: data.tip, treeHash: '0'.repeat(40), parents: [], message: 'Fixture commit', author: { name: 'Fixture', email: 'fixture@example.invalid' }, committer: { name: 'Fixture', email: 'fixture@example.invalid' }, authoredAt: 1, committedAt: 1 }] : []
    };
  }
}
export const memoryArtifacts = new MemoryArtifacts();
