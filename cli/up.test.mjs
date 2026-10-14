// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkPrerequisites, localWranglerConfig, parseArgs, root, HEDDLE_VERSION, HEDDLE_INSTALL } from './up.mjs';

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
  const config = localWranglerConfig({ repo: '/repo', vars: { OPERATOR_TOKEN: 't' } });
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
