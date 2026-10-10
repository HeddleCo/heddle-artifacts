// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function git(args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const out = [], err = [];
    child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString()) : reject(new Error('git operation failed', { cause: { code } })));
    child.stdin.end(input);
  });
}
const hash = v => createHash('sha256').update(v).digest('hex');
const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
export class FakeArtifacts {
  constructor({ root, origin = 'http://127.0.0.1:8788', namespace = 'heddle-demo', eventUrl = 'http://127.0.0.1:8787/__dev/events', now = Date.now }) {
    this.root = resolve(root); this.origin = origin; this.namespace = namespace;
    this.eventUrl = eventUrl; this.now = now; this.writeTail = Promise.resolve();
  }
  path(name) { if (!namePattern.test(name)) throw new Error('INVALID_INPUT'); return join(this.root, `${name}.git`); }
  remote(name) { this.path(name); return `${this.origin}/git/${this.namespace}/${name}.git`; }
  async load(name) { return JSON.parse(await readFile(join(this.path(name), 'fake.json'), 'utf8')); }
  async save(name, data) { await writeFile(join(this.path(name), 'fake.json'), JSON.stringify(data)); }
  async serial(fn) { const p = this.writeTail.then(fn); this.writeTail = p.catch(() => {}); return p; }
  async create(name, opts = {}) {
    return this.serial(async () => {
      await mkdir(this.root, { recursive: true });
      await mkdir(this.path(name));
      await git(['init', '--bare', '--initial-branch', opts.setDefaultBranch ?? 'main', this.path(name)]);
      await git(['config', 'http.receivepack', 'true'], this.path(name));
      await git(['config', 'receive.advertiseAtomic', 'true'], this.path(name));
      const metadata = { name, remote: this.remote(name), defaultBranch: opts.setDefaultBranch ?? 'main', description: opts.description ?? '', readOnly: !!opts.readOnly, status: 'ready', createdAt: new Date(this.now()).toISOString(), tokens: [] };
      await this.save(name, metadata); await this.installHook(name);
      const token = await this.mint(name, 'write', 3600);
      return { ...this.infoOf(metadata), token: token.plaintext };
    });
  }
  infoOf(data) { const { tokens, ...info } = data; return info; }
  async get(name) { await this.load(name); return new FakeRepo(this, name); }
  async list() { const { readdir } = await import('node:fs/promises'); const dirs = await readdir(this.root); return { repos: await Promise.all(dirs.filter(x => x.endsWith('.git')).map(async x => this.infoOf(await this.load(x.slice(0, -4))))) }; }
  async delete(name) { await rm(this.path(name), { recursive: true }); return true; }
  async mint(name, scope, ttl = 3600) {
    if (!['read', 'write'].includes(scope) || !Number.isInteger(ttl) || ttl <= 0) throw new Error('INVALID_INPUT');
    const data = await this.load(name), id = randomBytes(16).toString('hex');
    const expiresAt = new Date(this.now() + ttl * 1000).toISOString();
    const plaintext = `art_v1_${randomBytes(32).toString('hex')}?expires=${Math.floor(this.now() / 1000) + ttl}`;
    data.tokens.push({ id, hash: hash(plaintext), scope, expiresAt }); await this.save(name, data);
    return { id, plaintext, expiresAt };
  }
  async authorize(name, token, write = false) {
    const data = await this.load(name);
    return data.tokens.some(t => t.hash === hash(token) && Date.parse(t.expiresAt) > this.now() && (!write || t.scope === 'write')) && (!write || !data.readOnly);
  }
  async installHook(name) {
    const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    const emitter = fileURLToPath(new URL('./post-receive.mjs', import.meta.url));
    await writeFile(join(this.path(name), 'hooks', 'post-receive'), `#!/bin/sh\n# SPDX-License-Identifier: Apache-2.0\nexec ${shellQuote(process.execPath)} ${shellQuote(emitter)} ${shellQuote(this.eventUrl)} ${shellQuote(this.namespace)} ${shellQuote(name)}\n`, { mode: 0o755 });
  }
}
class FakeRepo {
  constructor(binding, name) { this.binding = binding; this.name = name; }
  [Symbol.dispose]() {}
  async info() { return this.binding.infoOf(await this.binding.load(this.name)); }
  async createToken(scope = 'write', ttl = 3600) { return this.binding.serial(() => this.binding.mint(this.name, scope, ttl)); }
  async listTokens() { const data = await this.binding.load(this.name); return { total: data.tokens.length, tokens: data.tokens.map(({ hash, ...t }) => t) }; }
  async revokeToken(value) { return this.binding.serial(async () => { const data = await this.binding.load(this.name), count = data.tokens.length; data.tokens = data.tokens.filter(t => t.id !== value && t.hash !== hash(value)); await this.binding.save(this.name, data); return count !== data.tokens.length; }); }
  async fork(name, opts = {}) {
    const created = await this.binding.create(name, opts);
    const src = this.binding.path(this.name), dest = this.binding.path(name), info = await this.info();
    const refs = opts.defaultBranchOnly ? [`refs/heads/${info.defaultBranch}:refs/heads/${info.defaultBranch}`] : ['+refs/*:refs/*'];
    try { await git(['fetch', src, ...refs], dest); } catch (e) { if ((await this.log()).length) throw e; }
    await git(['symbolic-ref', 'HEAD', `refs/heads/${info.defaultBranch}`], dest);
    const data = await this.binding.load(name); data.defaultBranch = info.defaultBranch; await this.binding.save(name, data);
    return { ...created, defaultBranch: info.defaultBranch };
  }
  async log({ ref = 'HEAD', limit = 50, offset = 0 } = {}) {
    if (!/^[a-zA-Z0-9/._-]+$/.test(ref) || ref.startsWith('-')) throw new Error('INVALID_INPUT');
    try {
      const output = await git(['log', '--first-parent', `--max-count=${Math.min(limit, 1000)}`, `--skip=${offset}`, '--format=%H', ref], this.binding.path(this.name));
      return Promise.all(output.trim().split('\n').filter(Boolean).map(sha => this.readCommit(sha)));
    } catch { return []; }
  }
  async readCommit(sha) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('INVALID_INPUT');
    const parts = (await git(['show', '-s', '--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%B', sha], this.binding.path(this.name))).split('\0');
    return { id: parts[0], parents: parts[1].split(' ').filter(Boolean), author: { name: parts[2], email: parts[3] }, committer: { name: parts[4], email: parts[5] }, timestamp: parts[6], message: parts[7].trimEnd() };
  }
}
