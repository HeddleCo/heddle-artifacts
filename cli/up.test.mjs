// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkPrerequisites, localWranglerConfig, localDevVars, parseArgs, root, HEDDLE_VERSION, HEDDLE_INSTALL, uiNeedsBuild, readOrCreateToken, waitUntil } from './up.mjs';
import { mkdtemp, mkdir, writeFile, utimes, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ok = output => ({ ok: true, output });
const good = { run: async (file) => ok(file.includes('heddle') ? `heddle ${HEDDLE_VERSION}\n` : 'x 1.0\n'), exists: async () => true, nodeVersion: '22.4.0', env: {} };

test('with everything present there is nothing to fix', async () => assert.deepEqual(await checkPrerequisites(good), []));

test('an old Node is reported with the version found', async () => {
  const problems = await checkPrerequisites({ ...good, nodeVersion: '20.11.1' });
  assert.equal(problems.length, 1); assert.match(problems[0].fix, /20\.11\.1/);
});

test('each missing tool is reported by name, and only that one', async () => {
  for (const tool of ['git', 'tar', 'zstd']) {
    const problems = await checkPrerequisites({ ...good, run: async file => file === tool ? { ok: false, output: '' } : good.run(file) });
    assert.deepEqual(problems.map(p => p.item), [tool]);
  }
});

test('a missing or wrong Heddle is reported with the install command and is never built for the user', async () => {
  const missing = await checkPrerequisites({ ...good, run: async file => file.includes('heddle') ? { ok: false, output: '' } : good.run(file) });
  assert.equal(missing.length, 1); assert.ok(missing[0].fix.includes(HEDDLE_INSTALL)); assert.match(missing[0].fix, /will not do it for you/);
  const wrong = await checkPrerequisites({ ...good, run: async file => file.includes('heddle') ? ok('heddle 0.29.0\n') : good.run(file) });
  assert.equal(wrong.length, 1); assert.match(wrong[0].fix, /0\.29\.0/);
});

test('HEDDLE_BIN selects the binary that is checked', async () => {
  const seen = []; await checkPrerequisites({ ...good, env: { HEDDLE_BIN: '/opt/heddle/bin/heddle' }, run: async (file, args) => { seen.push(file); return good.run(file, args); } });
  assert.ok(seen.includes('/opt/heddle/bin/heddle'));
});

test('missing dependencies say how to install them', async () => {
  const problems = await checkPrerequisites({ ...good, exists: async () => false });
  assert.deepEqual(problems.map(p => p.fix), ['Run: npm ci', 'Run: npm ci --prefix ui']);
});

test('the local Worker config uses the real local Worker and no reviewer, and carries no fixture', () => {
  const config = localWranglerConfig({ repo: '/repo', vars: { FAKE_ARTIFACTS_URL: 'http://127.0.0.1:1' } });
  assert.equal(config.main, '/repo/dev/local-worker.ts'); assert.equal(config.alias['heddle-reviewer'], '/repo/dev/no-reviewer.ts');
  assert.equal(config.vars.DEMO_PROJECT, '', 'no project is public by default');
  assert.doesNotMatch(JSON.stringify(config), /test-worker|fake-test-runner|stub-reviewer|stub-engine/);
});

test('dev/local-worker.ts never imports a test fixture, so a local run cannot show invented results', async () => {
  for (const file of ['dev/local-worker.ts', 'dev/no-reviewer.ts']) {
    const source = await readFile(join(root, file), 'utf8');
    assert.doesNotMatch(source, /fake-test-runner|stub-engine|stub-reviewer|memory-artifacts|fakeTestRunner/, file);
  }
});

test('options: defaults, overrides and bad input', () => {
  assert.equal(parseArgs(['local']).target, 'local'); assert.equal(parseArgs(['local', '--port', '4200']).port, 4200);
  assert.match(parseArgs(['local', '--state', '/tmp/x']).state, /\/tmp\/x$/);
  assert.throws(() => parseArgs(['local', '--nope']), /Unknown option/); assert.throws(() => parseArgs(['local', '--port', 'abc']), /port/);
});

test('secrets never go into the Worker config (wrangler prints a config\'s vars into its log); they go in a dev-vars file, which wrangler prints as hidden', () => {
  for (const key of ['OPERATOR_TOKEN', 'LOCAL_RUNNER_SECRET']) assert.throws(() => localWranglerConfig({ repo: '/repo', vars: { [key]: 'x'.repeat(40) } }), /secret/i, key);
  const text = localDevVars({ token: 'a'.repeat(64), runnerSecret: 'b'.repeat(48) });
  assert.match(text, /^OPERATOR_TOKEN="a{64}"$/m); assert.match(text, /^LOCAL_RUNNER_SECRET="b{48}"$/m);
  assert.throws(() => localDevVars({ token: 'bad"quote', runnerSecret: 'b'.repeat(48) }), /token/i, 'a value that could break out of the file is refused');
  assert.throws(() => localDevVars({ token: 'a\nINJECT=1', runnerSecret: 'b'.repeat(48) }), /token/i);
});

test('the UI is rebuilt when it is missing or older than its sources, and left alone when it is current', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ui-stale-')); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await uiNeedsBuild(dir), true, 'no dist at all');
  await mkdir(join(dir, 'ui/src'), { recursive: true }); await mkdir(join(dir, 'ui/dist'), { recursive: true });
  await writeFile(join(dir, 'ui/src/app.tsx'), 'x'); await writeFile(join(dir, 'ui/style.css'), 'x'); await writeFile(join(dir, 'ui/dist/index.html'), 'x'); await writeFile(join(dir, 'ui/dist/app.js'), 'x');
  const past = new Date(Date.now() - 60000), now = new Date();
  await utimes(join(dir, 'ui/src/app.tsx'), past, past); await utimes(join(dir, 'ui/style.css'), past, past); await utimes(join(dir, 'ui/dist/app.js'), now, now);
  assert.equal(await uiNeedsBuild(dir), false, 'dist newer than every source');
  await utimes(join(dir, 'ui/src/app.tsx'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(await uiNeedsBuild(dir), true, 'a source changed after the build');
  await utimes(join(dir, 'ui/src/app.tsx'), past, past); await utimes(join(dir, 'ui/style.css'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(await uiNeedsBuild(dir), true, 'the stylesheet counts too');
});

test('an empty, short or damaged token file is replaced, never used; a good one is kept; the file is mode 0600', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tok-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'operator-token');
  for (const bad of ['', '\n', 'short', 'has space in it but is long enough to pass a length check 1234567890']) {
    await writeFile(file, bad, { mode: 0o644 });
    const token = await readOrCreateToken(file);
    assert.match(token, /^[0-9a-f]{64}$/, JSON.stringify(bad)); assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  const good = 'c'.repeat(64); await writeFile(file, `${good}\n`, { mode: 0o600 });
  assert.equal(await readOrCreateToken(file), good);
});

test('waiting for the app stops at once if the process behind it has died or the user asked to stop, instead of waiting out the timeout', async () => {
  const started = Date.now();
  await assert.rejects(() => waitUntil(async () => false, 30000, 'The app', () => 'wrangler exited early'), /wrangler exited early/);
  await assert.rejects(() => waitUntil(async () => false, 30000, 'The app', () => 'stopped'), /stopped/);
  assert.ok(Date.now() - started < 3000, 'did not wait for the 30 s limit');
  await waitUntil(async () => true, 1000, 'The app', () => null);
  await assert.rejects(() => waitUntil(async () => false, 600, 'The app', () => null), /did not start in/);
});
