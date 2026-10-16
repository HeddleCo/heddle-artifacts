// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectURL, remoteURL, gitAuth, joinProject, request, redact, command, API_TIMEOUT_MS, briefingMarkdown, resolveCommit } from './ha.mjs';
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

for (const setupMode of ['none', 'child', 'track-A']) {
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
    const headers = await command('git', ['config', '--get-all', `http.${mock.url}/git/cli--docs--alice.git.extraHeader`], { cwd: result.cwd });
    assert.equal(headers.split('\n').length, 1);
    await command('git', ['fetch', '--quiet', 'upstream'], { cwd: result.cwd });
    assert.deepEqual(await readdir(join(parent, '.git')), parentEntries);
    assert.equal(await readFile(join(parent, '.git/config'), 'utf8'), parentConfig);
  });
}
test('API timeout outlasts a measured Container cold start', () => {
  assert.ok(API_TIMEOUT_MS >= 60000, 'first engine calls boot a Container and took up to 57 s live');
});

test('join leaves a briefing where a coding agent reads it, and Git never commits it', async t => {
  const mock = await startMock(); t.after(mock.close);
  const dir = await mkdtemp(join(tmpdir(), 'heddle-D-brief-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await request(`${mock.url}/api/projects`, mock.operatorToken, { id: 'cli', seed: { template: 'demo' } });
  await request(`${mock.url}/api/projects/cli/tasks`, mock.operatorToken, { slug: 'docs', intent: 'Document the escaping rules' });
  const result = await joinProject(`${mock.url}/p/cli`, { task: 'docs', as: 'alice', token: mock.operatorToken, directory: join(dir, 'clone') });
  const briefing = await readFile(join(result.cwd, '.heddle/BRIEFING.md'), 'utf8');
  assert.match(briefing, /Document the escaping rules/);
  assert.match(briefing, /Earlier decisions on this code \(0\)/);
  for (const name of ['AGENTS.md', 'CLAUDE.md']) assert.match(await readFile(join(result.cwd, name), 'utf8'), /\.heddle\/BRIEFING\.md/);
  assert.deepEqual(result.briefing.pointers, ['AGENTS.md', 'CLAUDE.md']);
  assert.equal(await command('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: result.cwd }), '');
});
test('the briefing quotes carried-forward reasons with where they apply and who gave them', () => {
  const text = briefingMarkdown({ project: 'demo', task: 'parser-escapes', agent: 'dave', intent: 'Handle escapes', briefing: { hash: 'f'.repeat(64), omitted: 1,
    annotations: [{ target: 'src/table.ts', scope: 'symbol:parseRow', kind: 'rationale', content: 'Keep parsing explicit.\nNo lookbehind.', attribution: 'Luke Judge <luke@demo.local>', tags: ['parser'], annotationId: 'a', revisionId: 'r' }] } });
  assert.match(text, /### Rationale: src\/table\.ts · parseRow/);
  assert.match(text, /> Keep parsing explicit\.\n> No lookbehind\./);
  assert.match(text, /by Luke Judge · tags: parser/);
  assert.match(text, /1 more did not fit/);
});
test('why accepts a short SHA or a ref, and refuses option-like input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heddle-D-why-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await command('git', ['init', '--quiet', dir]);
  await command('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '--quiet', '--allow-empty', '-m', 'one'], { cwd: dir });
  const full = await command('git', ['rev-parse', 'HEAD'], { cwd: dir });
  assert.equal(await resolveCommit(full.slice(0, 8), dir), full);
  assert.equal(await resolveCommit('HEAD', dir), full);
  await assert.rejects(resolveCommit('--output=/tmp/x', dir), /a SHA/);
  await assert.rejects(resolveCommit('deadbeef', dir), /git fetch upstream main/);
});
