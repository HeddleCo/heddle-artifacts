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
    const [commit] = await repo.log({ ref: 'main', limit: 1 });
    assert.deepEqual(commit, await repo.readCommit(sha));
    assert.deepEqual(Object.keys(commit).sort(), ['hash', 'treeHash', 'parents', 'author', 'committer', 'authoredAt', 'committedAt', 'message'].sort());
    assert.equal(commit.hash, sha); assert.equal(commit.treeHash, (await git(['rev-parse', 'HEAD^{tree}'], work)).trim());
    assert.equal(commit.authoredAt, Number((await git(['show', '-s', '--format=%at', sha], work)).trim()));
    assert.equal(commit.committedAt, Number((await git(['show', '-s', '--format=%ct', sha], work)).trim()));
    assert.equal(commit.message, 'seed');
    const fork = await repo.fork('project--task--alice', { defaultBranchOnly: true });
    assert.equal((await (await fake.binding.get(fork.name)).log({ ref: 'main', limit: 1 }))[0].hash, sha);
    assert.equal(await fake.binding.authorize(fork.name, token.plaintext), false);
    await assert.rejects(git(['-c', `http.extraHeader=Authorization: Bearer ${read.plaintext}`, 'push', canonical.remote, 'HEAD:refs/heads/denied'], work));
    assert.equal(await repo.revokeToken(token.id), true);
    await assert.rejects(git([...auth, 'ls-remote', canonical.remote]));
    clock += 3601000;
    await assert.rejects(git(['-c', `http.extraHeader=Authorization: Bearer ${read.plaintext}`, 'ls-remote', canonical.remote]));
    assert.equal(events.filter(e => e.payload.ref === 'refs/heads/main').length, 1);
    assert.equal(events[0].type, 'cf.artifacts.repo.pushed'); assert.equal(events[0].source.repoName, 'project'); assert.equal(events[0].payload.after, sha);
    assert.equal(events[0].payload.commits[0].id, sha); assert.equal(typeof events[0].payload.commits[0].timestamp, 'string');
    assert.equal(events[0].payload.commits[0].hash, undefined);
    assert.ok(!JSON.stringify(await repo.listTokens()).includes(read.plaintext));
    console.log('FakeArtifacts: main, candidates, notes, atomic push, hook, fork scope, read-only, revoke and expiry verified');
  } finally { await fake.close(); await new Promise(r => hook.close(r)); await rm(dir, { recursive: true, force: true }); }
});

test('binding errors retain provider name, code and numericCode across local HTTP without raw diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifacts-errors-'));
  const fake = await startFakeArtifacts({ root: join(dir, 'repos'), port: 0 });
  const call = (method, args, repo) => fetch(`${fake.origin}/__binding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args, repo }) });
  try {
    const missing = { name: 'ArtifactsError', code: 'NOT_FOUND', numericCode: 10200 };
    await assert.rejects(fake.binding.get('absent'), missing);
    const absent = await call('get', ['absent']);
    assert.equal(absent.status, 404); assert.deepEqual(await absent.json(), { error: missing });
    const info = await call('info', [], 'absent');
    assert.equal(info.status, 404); assert.deepEqual(await info.json(), { error: missing });
    await fake.binding.create('project');
    const duplicate = { name: 'ArtifactsError', code: 'ALREADY_EXISTS', numericCode: 10201 };
    await assert.rejects(fake.binding.create('project'), duplicate);
    const exists = await call('create', ['project']);
    assert.equal(exists.status, 409); assert.deepEqual(await exists.json(), { error: duplicate });
    for (const [code, numericCode] of [['INTERNAL_ERROR', 10400], ['IMPORT_IN_PROGRESS', 10302], ['FORK_IN_PROGRESS', 10303]]) {
      fake.binding.get = async () => { throw Object.assign(new Error('private-fixture-diagnostic'), { name: 'ArtifactsError', code, numericCode }); };
      const response = await call('get', ['project']);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: { name: 'ArtifactsError', code, numericCode } });
    }
  } finally { await fake.close(); await rm(dir, { recursive: true, force: true }); }
});
