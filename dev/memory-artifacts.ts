// SPDX-License-Identifier: Apache-2.0
// Workers-pool binding fixture. Smart HTTP is tested separately against FakeArtifacts.
import type { ArtifactsBinding, ArtifactsRepo, RepoInfo } from '../worker/env';
export class MemoryArtifacts implements ArtifactsBinding {
  repos = new Map<string, { info: RepoInfo; tip?: string; tokens: Map<string, string> }>();
  async create(name: string) {
    if (this.repos.has(name)) throw new Error('exists');
    const info = { name, remote: `http://artifacts/git/heddle-demo/${name}.git`, defaultBranch: 'main' };
    this.repos.set(name, { info, tokens: new Map() }); return info;
  }
  async get(name: string): Promise<ArtifactsRepo> {
    const data = this.repos.get(name); if (!data) throw new Error('missing');
    return { [Symbol.dispose]() {}, info: async () => data.info,
      fork: async (name: string) => { const info = await this.create(name); this.repos.get(name)!.tip = data.tip; return info; },
      createToken: async (scope: string, ttl: number) => { const id = crypto.randomUUID(), plaintext = crypto.randomUUID(); data.tokens.set(id, plaintext); return { id, plaintext, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; },
      revokeToken: async token => data.tokens.delete(token),
      log: async () => data.tip ? [{ id: data.tip }] : []
    };
  }
}
export const memoryArtifacts = new MemoryArtifacts();
