// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectURL, remoteURL, gitAuth, joinProject, request, redact, command } from './ha.mjs';
import { startMock } from '../demo/test/mock-platform.mjs';
test('CLI URL guards reject credentials, nonlocal HTTP and invalid identifiers', () => {
  for (const url of ['http://example.com/p/demo', 'https://x:token@example.com/p/demo', 'https://example.com/p/demo?token=abc', 'https://example.com/p/demo/extra']) assert.throws(() => projectURL(url));
  assert.equal(projectURL('https://worker.example/p/demo').api, 'https://worker.example/api/projects/demo');
  assert.throws(() => remoteURL('https://x:token@git.example/a.git', 'https://worker.example/api/projects/demo'));
  assert.throws(() => gitAuth([['https://git.example/a.git', 'line\nbreak']]));
  assert.deepEqual(redact({ setup: 'private', agentKey: 'private', readToken: 'private', publicKey: 'public', body: 'Bearer private' }), { publicKey: 'public', body: 'Bearer [REDACTED]' });
});
test('join refuses a populated destination and never alters the parent repository', async t => {
  const mock = await startMock(); t.after(mock.close);
  const dir = await mkdtemp(join(tmpdir(), 'heddle-D-join-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await request(`${mock.url}/api/projects`, mock.operatorToken, { id: 'cli', seed: { template: 'demo' } });
  await request(`${mock.url}/api/projects/cli/tasks`, mock.operatorToken, { slug: 'docs', intent: 'docs' });
  await writeFile(join(dir, 'keep'), 'do not replace');
  await assert.rejects(joinProject(`${mock.url}/p/cli`, { task: 'docs', as: 'alice', token: mock.operatorToken, directory: dir }), /empty destination/);
  assert.deepEqual(await readdir(dir), ['keep']);
  assert.equal(mock.projects.get('cli').agents.length, 0);
});
test('API authorization errors are typed and do not expose server credentials', async t => {
  const mock = await startMock(); t.after(mock.close);
  await assert.rejects(request(`${mock.url}/api/projects`, 'wrong', { id: 'cli', seed: { template: 'demo' } }), e => e.status === 403 && e.message === 'HTTP 403: API request rejected');
});

for (const setupMode of ['none', 'child']) {
  test(`setup ${setupMode} creates an independent clone inside a parent Git checkout`, async t => {
    const mock = await startMock({ setupMode }); t.after(mock.close);
    const parent = await mkdtemp(join(tmpdir(), 'heddle-D-parent-')); t.after(() => rm(parent, { recursive: true, force: true }));
    await command('git', ['init', '--quiet', parent]);
    const parentConfig = await readFile(join(parent, '.git/config'), 'utf8');
    const parentEntries = await readdir(join(parent, '.git')); 
    await request(`${mock.url}/api/projects`, mock.operatorToken, { id: 'cli', seed: { template: 'demo' } });
    await request(`${mock.url}/api/projects/cli/tasks`, mock.operatorToken, { slug: 'docs', intent: 'docs' });
    const result = await joinProject(`${mock.url}/p/cli`, { task: 'docs', as: 'alice', token: mock.operatorToken, directory: join(parent, 'clone') });
    assert.equal(await command('git', ['rev-parse', '--show-toplevel'], { cwd: result.cwd }), result.cwd);
    assert.ok(result.cwd.startsWith(parent));
    assert.deepEqual(await readdir(join(parent, '.git')), parentEntries);
    assert.equal(await readFile(join(parent, '.git/config'), 'utf8'), parentConfig);
  });
}
