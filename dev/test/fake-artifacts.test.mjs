// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startFakeArtifacts } from '../fake-artifacts/server.mjs';
import { git } from '../fake-artifacts/binding.mjs';

test('smart HTTP: real Git push/fork/clone, scoped expiring tokens, notes, atomic refs and events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifacts-test-')), events = []; let clock = Date.now();
  const hook = createServer(async (req, res) => { let body = ''; for await (const b of req) body += b; events.push(JSON.parse(body)); res.end('ok'); });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  const fake = await startFakeArtifacts({ root: join(dir, 'repos'), port: 0, eventUrl: `http://127.0.0.1:${hook.address().port}/__dev/events`, now: () => clock });
  try {
    const canonical = await fake.binding.create('project');
    const repo = await fake.binding.get('project');
    const token = await repo.createToken('write', 3600), read = await repo.createToken('read', 3600);
    const work = join(dir, 'work'); await mkdir(work);
    await git(['init', '--initial-branch=main'], work); await git(['config', 'user.name', 'Test'], work); await git(['config', 'user.email', 'test@example.invalid'], work);
    await writeFile(join(work, 'README.md'), 'seed'); await git(['add', '.'], work); await git(['commit', '-m', 'seed'], work);
    const sha = (await git(['rev-parse', 'HEAD'], work)).trim();
    const auth = ['-c', `http.extraHeader=Authorization: Bearer ${token.plaintext}`];
    await git([...auth, 'push', canonical.remote, 'HEAD:main'], work);
    await git(['notes', '--ref=heddle-why', 'add', '-m', 'Chosen: bob'], work);
    await git([...auth, 'push', '--atomic', canonical.remote, 'HEAD:refs/heads/candidates/x/y', 'refs/notes/heddle-why'], work);
    const refs = await git(['-c', `http.extraHeader=Authorization: Bearer ${read.plaintext}`, 'ls-remote', canonical.remote]);
    assert.match(refs, /refs\/notes\/heddle-why/); assert.match(refs, /refs\/heads\/candidates\/x\/y/);
    assert.equal((await repo.log({ ref: 'main', limit: 1 }))[0].id, sha);
    const fork = await repo.fork('project--task--alice', { defaultBranchOnly: true });
    assert.equal((await (await fake.binding.get(fork.name)).log({ ref: 'main', limit: 1 }))[0].id, sha);
    assert.equal(await fake.binding.authorize(fork.name, token.plaintext), false);
    await assert.rejects(git(['-c', `http.extraHeader=Authorization: Bearer ${read.plaintext}`, 'push', canonical.remote, 'HEAD:refs/heads/denied'], work));
    assert.equal(await repo.revokeToken(token.id), true);
    await assert.rejects(git([...auth, 'ls-remote', canonical.remote]));
    clock += 3601000;
    await assert.rejects(git(['-c', `http.extraHeader=Authorization: Bearer ${read.plaintext}`, 'ls-remote', canonical.remote]));
    assert.equal(events.filter(e => e.payload.ref === 'refs/heads/main').length, 1);
    assert.equal(events[0].type, 'cf.artifacts.repo.pushed'); assert.equal(events[0].source.repoName, 'project'); assert.equal(events[0].payload.after, sha);
    assert.ok(!JSON.stringify(await repo.listTokens()).includes(read.plaintext));
    console.log('FakeArtifacts: main, candidates, notes, atomic push, hook, fork scope, read-only, revoke and expiry verified');
  } finally { await fake.close(); await new Promise(r => hook.close(r)); await rm(dir, { recursive: true, force: true }); }
});
