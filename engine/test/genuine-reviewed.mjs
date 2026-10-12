// SPDX-License-Identifier: Apache-2.0
// Integration gate for exact reviewed genuine-agent source replays. No new coding
// or human decision occurs here. Candidate sources are deliberately not in the
// image: CI may mount them read-only and pass --fixture-root /fixtures/candidates.
// Run this script against the image's engine/lib and default demo manifest; do
// not mount a checkout over those paths or substitute an operator test manifest.
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { authorizeCandidateTree } from '../lib/trusted-tests.mjs';
import { testCandidate } from '../lib/tests.mjs';
import { run } from '../lib/process.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--fixture-root' && isAbsolute(args[1])),
  'Usage: node engine/test/genuine-reviewed.mjs [--fixture-root /absolute/read-only/candidates]');
const fixtureRoot = args[1] || fileURLToPath(new URL('../../demo/evidence/genuine-native-v1/candidates/', import.meta.url));
const files = ['README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'src/table.ts', 'test/table.test.ts', 'test/escapes.test.ts'];
const expected = [
  { agent: 'native-scan', sha256: '266e3f9e01bb63cd2f4139b9a225b83557733d656520869f856f8c764c7aff61', passed: 56 },
  { agent: 'native-parity', sha256: 'd3782809f58026c35839bc7226d1b54e43d46e5fc7f6320a12b9b4b5fdb37287', passed: 70 },
];
const manifest = JSON.parse(await readFile(new URL('../../demo/trusted-test-trees.json', import.meta.url)));
assert.deepEqual(manifest.trees.map(tree => tree.name),
  ['demo-seed', 'demo-alice', 'demo-bob', 'demo-carol', ...expected.map(({ agent }) => `genuine-${agent}`)]);
const root = await mkdtemp(join(tmpdir(), 'heddle-genuine-reviewed-'));
const previous = { manifest: process.env.HEDDLE_TRUSTED_TEST_MANIFEST, path: process.env.PATH };
// An inherited operator override must not accidentally make the image gate pass.
delete process.env.HEDDLE_TRUSTED_TEST_MANIFEST;
try {
  const snapshots = new Map();
  for (const { agent, sha256, passed } of expected) {
    const candidate = join(fixtureRoot, agent);
    assert.deepEqual(await authorizeCandidateTree(candidate), { authorized: true, fixture: `genuine-${agent}`, sha256 });
    snapshots.set(agent, Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(candidate, file))]))));
    const result = await testCandidate(candidate);
    assert.equal(result.status, 'pass', `${agent}: ${result.summary}`);
    assert.equal(result.passed, passed, `${agent}: ${result.summary}`);
    assert.equal(result.failed, 0);
    // All installation/execution is in the guard's private copy, never the fixture.
    await assert.rejects(access(join(candidate, 'node_modules')), { code: 'ENOENT' });
    for (const [file, contents] of Object.entries(snapshots.get(agent))) assert.deepEqual(await readFile(join(candidate, file)), contents);
    console.log(`${agent} PASS: default trusted manifest; ${passed}/${passed} tests; ${result.durationMs} ms; ${sha256}`);
  }

  const bin = join(root, 'witness-bin'), spawned = join(root, 'npm-spawned');
  await mkdir(bin, { mode: 0o700 });
  await writeFile(join(bin, 'npm'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(spawned)}, 'npm invoked');\nprocess.exit(99);\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${previous.path || ''}`;
  // Prove the witness is executable and is the npm selected by the real runner.
  assert.equal((await run('npm', ['--version'], { cwd: root, allowFailure: true })).code, 99);
  assert.equal(await readFile(spawned, 'utf8'), 'npm invoked');
  await rm(spawned);
  for (const { agent } of expected) {
    for (const mutation of ['changed-source', 'extra-file']) {
      const candidate = join(root, `${agent}-${mutation}`);
      await mkdir(candidate, { mode: 0o700 });
      for (const directory of ['src', 'test']) await mkdir(join(candidate, directory), { mode: 0o700 });
      for (const [file, contents] of Object.entries(snapshots.get(agent))) await writeFile(join(candidate, file), contents, { mode: 0o600 });
      if (mutation === 'changed-source') await writeFile(join(candidate, 'src/table.ts'), Buffer.concat([snapshots.get(agent)['src/table.ts'], Buffer.from('\n// unreviewed change\n')]));
      else await writeFile(join(candidate, 'unexpected.txt'), 'unreviewed extra file\n', { mode: 0o600 });
      const result = await testCandidate(candidate);
      assert.equal(result.status, 'skipped');
      assert.match(result.summary, /^Tests withheld: complete source tree is not in the operator-reviewed SHA-256 allowlist$/);
      assert.equal(result.passed, 0); assert.equal(result.failed, 0);
      await assert.rejects(access(spawned), { code: 'ENOENT' }, 'Neither npm ci nor npm test may start for changed source');
      console.log(`${agent} ${mutation} PASS: withheld before any npm execution`);
    }
  }
} finally {
  for (const [name, value] of [['HEDDLE_TRUSTED_TEST_MANIFEST', previous.manifest], ['PATH', previous.path]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
}
