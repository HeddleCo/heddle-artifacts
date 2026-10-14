// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCandidateLocally } from '../local-test-runner.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();

/** A one-commit repo whose single test file is the given source. */
async function candidate(root, name, testSource) {
  const dir = join(root, name); await mkdir(dir, { recursive: true });
  git(dir, 'init', '--initial-branch=main');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { test: 'node --test' } }));
  await writeFile(join(dir, 'a.test.mjs'), testSource);
  git(dir, 'add', '.'); git(dir, 'commit', '-m', 'candidate');
  return { remote: dir, sourceSha: git(dir, 'rev-parse', 'HEAD'), treeSha: git(dir, 'rev-parse', 'HEAD^{tree}') };
}
const input = (c, extra = {}) => ({ project: 'p', task: 't', agent: 'a', readCredential: 'secret-read-token-123', recipe: { setup: [], test: ['node', '--test'], budgetMs: 30000 }, ...c, ...extra });
const opts = root => ({ root: join(root, 'work'), allowFileRemotes: true });
const withRoot = async fn => { const root = await mkdtemp(join(tmpdir(), 'local-runner-')); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } };

test('a passing candidate is actually executed and reports its own counts', () => withRoot(async root => {
  const c = await candidate(root, 'pass', "import test from 'node:test'; test('one', () => {}); test('two', () => {});");
  const run = await runCandidateLocally(input(c), opts(root));
  assert.equal(run.testExitCode, 0);
  assert.equal(run.sourceSha, c.sourceSha); assert.equal(run.treeSha, c.treeSha);
  assert.match(run.output, /^# pass 2$/m); assert.match(run.output, /^# fail 0$/m);
}));

test('a failing candidate is reported failing: the result comes from running it, not from a fixture', () => withRoot(async root => {
  const c = await candidate(root, 'fail', "import test from 'node:test'; import assert from 'node:assert'; test('ok', () => {}); test('broken', () => assert.equal(1, 2));");
  const run = await runCandidate(c, root);
  assert.notEqual(run.testExitCode, 0);
  assert.match(run.output, /^# pass 1$/m); assert.match(run.output, /^# fail 1$/m);
}));
const runCandidate = (c, root, extra) => runCandidateLocally(input(c, extra), opts(root));

test('only npm, npx and node may run; a shell is refused before anything executes', () => withRoot(async root => {
  const c = await candidate(root, 'shell', "import test from 'node:test'; test('x', () => {});");
  await assert.rejects(() => runCandidate(c, root, { recipe: { setup: [], test: ['sh', '-c', 'echo pwned > /tmp/should-not-exist'], budgetMs: 30000 } }), /recipe/i);
}));

test('a checkout that does not match the recorded tree is rejected', () => withRoot(async root => {
  const c = await candidate(root, 'tree', "import test from 'node:test'; test('x', () => {});");
  const run = await runCandidate({ ...c, treeSha: '0'.repeat(40) }, root);
  assert.equal(run.failure, 'checkout'); assert.equal(run.testExitCode, undefined);
}));

test('the time budget is enforced and the run is killed', () => withRoot(async root => {
  const c = await candidate(root, 'slow', "import test from 'node:test'; test('hang', () => new Promise(() => setTimeout(() => {}, 60000)));");
  const started = Date.now();
  const run = await runCandidate(c, root, { recipe: { setup: [], test: ['node', '--test'], budgetMs: 1500 } });
  assert.equal(run.failure, 'timeout'); assert.ok(Date.now() - started < 10000, 'returned well before the test would have finished');
}));

test('candidate code never sees the read credential, in its environment or its output', () => withRoot(async root => {
  const c = await candidate(root, 'env', "import test from 'node:test'; test('env', () => { console.log('ENV:' + JSON.stringify(process.env)); });");
  const run = await runCandidate(c, root);
  assert.ok(run.output.includes('ENV:'), 'the test really ran');
  assert.ok(!run.output.includes('secret-read-token-123'));
  assert.ok(!/OPERATOR_TOKEN|AUTHORIZATION/i.test(run.output));
}));
