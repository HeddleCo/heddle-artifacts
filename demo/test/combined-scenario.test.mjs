// SPDX-License-Identifier: Apache-2.0
// The combined storyline's premise, on the real demo seed with its real Vitest suite: representative
// implementations of the two tasks each pass alone and merge without a conflict, but the merged code
// fails, because B's new tests rely on the trimming that A's task removes. Live agents write their own
// code; this shows the pair of intents is a reliable break, and that the sandbox parser names the failures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm, symlink, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isolatedTestResult } from '../../engine/lib/isolated-tests.mjs';

const demo = fileURLToPath(new URL('..', import.meta.url)), seed = join(demo, 'seed-project'), prepared = join(demo, 'scripted-agents', 'combined');
let root;
const git = (...args) => { const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const vitest = () => {
  const r = spawnSync(process.execPath, [join(seed, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--maxWorkers=1'], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  return { output: (r.stdout + r.stderr), code: r.status };
};
const result = run => isolatedTestResult({ sourceSha: '0'.repeat(40), treeSha: '0'.repeat(40), durationMs: 1, installExitCode: 0, testExitCode: run.code, output: run.output });

before(async () => {
  await access(join(seed, 'node_modules', 'vitest')).catch(() => { throw new Error('Run npm ci --prefix demo/seed-project first'); });
  root = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'combined-scenario-'));
  await cp(seed, root, { recursive: true, filter: path => !path.includes('node_modules') });
  await symlink(join(seed, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'Seed');
  git('checkout', '-q', '-b', 'erin');
  await cp(join(prepared, 'erin-table.ts'), join(root, 'src/table.ts')); await cp(join(prepared, 'erin-table.test.ts'), join(root, 'test/table.test.ts'));
  git('commit', '-q', '-am', 'Preserve whitespace inside cells');
  git('checkout', '-q', '-b', 'finn', 'main');
  await appendFile(join(root, 'src/table.ts'), await readFile(join(prepared, 'finn-read-table.ts'), 'utf8')); await cp(join(prepared, 'finn-read-table.test.ts'), join(root, 'test/read-table.test.ts'));
  git('add', '.'); git('commit', '-q', '-m', 'Return the header separately from the rows');
});
after(() => root && rm(root, { recursive: true, force: true }));

test('each task passes its own tests alone', () => {
  for (const branch of ['erin', 'finn']) {
    git('checkout', '-q', branch);
    const tests = result(vitest());
    assert.equal(tests.status, 'pass', `${branch} alone`); assert.equal(tests.failed, 0);
  }
});
test('the two merge without a conflict, and the merged code fails B\'s tests', () => {
  git('checkout', '-q', 'erin'); git('merge', '-q', '--no-edit', 'finn');
  assert.match(git('show', 'HEAD:src/table.ts'), /return text\.split\("\|"\);[\s\S]*export function readTable/);
  const tests = result(vitest());
  assert.equal(tests.status, 'fail'); assert.equal(tests.failed, 3);
  assert.deepEqual(tests.failures, ['test/read-table.test.ts > readTable > returns the header', 'test/read-table.test.ts > readTable > returns the body rows', 'test/read-table.test.ts > readTable > handles a header-only table']);
  assert.match(tests.excerpt, /' Name '/);
});
