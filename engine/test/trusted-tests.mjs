// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, link, rm, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReviewedFixtureEntry, authorizeCandidateTree, prepareReviewedFixture } from '../lib/trusted-tests.mjs';
import { testCandidate } from '../lib/tests.mjs';

test('trusted execution fails closed before npm and keeps native custody untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'heddle-trusted-test-proof-'));
  const old = { manifest: process.env.HEDDLE_TRUSTED_TEST_MANIFEST, state: process.env.ENGINE_STATE_DIR, path: process.env.PATH };
  const state = join(root, 'engine-state'); await mkdir(state);
  const sentinel = join(state, 'synthetic-sentinel.txt'), stolen = join(state, 'attempted-read.txt');
  await writeFile(sentinel, 'PUBLIC-SYNTHETIC-SENTINEL\n', { mode: 0o600 });
  const source = {
    'package.json': JSON.stringify({ name: 'reviewed-public-test-fixture', private: true, type: 'module', scripts: { test: 'node --test test.mjs' } }),
    'package-lock.json': JSON.stringify({ name: 'reviewed-public-test-fixture', lockfileVersion: 3, packages: { '': { name: 'reviewed-public-test-fixture' } } }),
    'test.mjs': '// SPDX-License-Identifier: Apache-2.0\nimport { test } from "node:test"; import assert from "node:assert/strict"; test("public arithmetic", () => assert.equal(2 + 2, 4));\n',
  };
  const manifest = join(root, 'operator-reviewed.json');
  await writeFile(manifest, JSON.stringify({ version: 1, trees: [createReviewedFixtureEntry('public-node-fixture', source)] }), { mode: 0o600 });
  process.env.HEDDLE_TRUSTED_TEST_MANIFEST = manifest;
  process.env.ENGINE_STATE_DIR = state;
  let serial = 0;
  async function candidate() {
    const path = join(root, `candidate-${++serial}`); await mkdir(path);
    for (const [name, contents] of Object.entries(source)) await writeFile(join(path, name), contents);
    return path;
  }
  const bin = join(root, 'fake-bin'), spawned = join(root, 'npm-spawned'); await mkdir(bin);
  await writeFile(join(bin, 'npm'), `#!/bin/sh\nprintf spawned > '${spawned}'\nexit 99\n`, { mode: 0o700 });
  async function withheld(path) {
    process.env.PATH = `${bin}:${old.path}`;
    try {
      const result = await testCandidate(path);
      assert.equal(result.status, 'skipped'); assert.match(result.summary, /^Tests withheld:/);
      await assert.rejects(access(spawned), { code: 'ENOENT' }, 'no npm process, even npm ci, may start');
      assert.equal(await readFile(sentinel, 'utf8'), 'PUBLIC-SYNTHETIC-SENTINEL\n');
      await assert.rejects(access(stolen), { code: 'ENOENT' });
      return result;
    } finally { process.env.PATH = old.path; }
  }
  try {
    await t.test('reviewed fixture passes, metadata is never copied, and source node_modules is never created', async () => {
      const path = await candidate();
      await mkdir(join(path, '.heddle')); await writeFile(join(path, '.heddle', 'synthetic-private-data'), 'DO-NOT-COPY');
      assert.equal((await authorizeCandidateTree(path)).authorized, true);
      const prepared = await prepareReviewedFixture(path); assert.equal(prepared.authorized, true);
      try { await assert.rejects(access(join(prepared.cwd, '.heddle')), { code: 'ENOENT' }); } finally { await prepared.cleanup(); }
      const result = await testCandidate(path); assert.equal(result.status, 'pass', result.summary); assert.equal(result.passed, 1);
      await assert.rejects(access(join(path, 'node_modules')), { code: 'ENOENT' });
    });
    await t.test('malicious test script cannot read or overwrite a synthetic engine-state sentinel', async () => {
      const path = await candidate();
      await writeFile(join(path, 'package.json'), JSON.stringify({ scripts: { test: 'node malicious.mjs' } }));
      await writeFile(join(path, 'malicious.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(stolen)}, fs.readFileSync(${JSON.stringify(sentinel)})); fs.writeFileSync(${JSON.stringify(sentinel)}, 'OVERWRITTEN');`);
      await withheld(path);
    });
    const cases = [
      ['changed test bytes', path => writeFile(join(path, 'test.mjs'), 'process.exit(0);\n')],
      ['changed lockfile', path => writeFile(join(path, 'package-lock.json'), source['package-lock.json'] + '\n')],
      ['untracked executable', path => writeFile(join(path, 'untracked.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })],
      ['npm config', path => writeFile(join(path, '.npmrc'), 'script-shell=/candidate-controlled\n')],
      ['candidate node_modules', async path => { await mkdir(join(path, 'node_modules')); await writeFile(join(path, 'node_modules', 'payload.mjs'), 'process.exit(0)'); }],
      ['nested ignored content', async path => { await mkdir(join(path, 'cache')); await writeFile(join(path, 'cache', '.hidden'), 'extra'); }],
      ['unexpected empty directory', path => mkdir(join(path, 'unused'))],
      ['source symlink', async path => { await rm(join(path, 'test.mjs')); await symlink(sentinel, join(path, 'test.mjs')); }],
      ['hardlink alias', async path => { const outside = join(root, `outside-${serial}`); await writeFile(outside, source['test.mjs']); await rm(join(path, 'test.mjs')); await link(outside, join(path, 'test.mjs')); }],
      ['changed executable mode', path => chmod(join(path, 'test.mjs'), 0o700)],
      ['unsafe file mode', path => chmod(join(path, 'test.mjs'), 0o666)],
      ['unsafe directory mode', async path => { await mkdir(join(path, 'unsafe')); await chmod(join(path, 'unsafe'), 0o777); }],
      ['native metadata symlink', path => symlink(state, join(path, '.heddle'))],
      ['nested native metadata', async path => { await mkdir(join(path, 'nested')); await mkdir(join(path, 'nested', '.heddle')); }],
      ['candidate Git metadata', path => mkdir(join(path, '.git'))],
    ];
    for (const [name, mutate] of cases) await t.test(`${name} is withheld before any npm spawn`, async () => { const path = await candidate(); await mutate(path); await withheld(path); });
    await t.test('candidate root symlink is withheld', async () => { const path = await candidate(), alias = join(root, 'candidate-alias'); await symlink(path, alias); await withheld(alias); });
    await t.test('candidate-supplied manifest cannot authorize itself', async () => {
      const path = await candidate(), supplied = join(path, 'trusted.json'); await writeFile(supplied, await readFile(manifest));
      process.env.HEDDLE_TRUSTED_TEST_MANIFEST = supplied;
      try { assert.match((await withheld(path)).summary, /inside the candidate/); } finally { process.env.HEDDLE_TRUSTED_TEST_MANIFEST = manifest; }
    });
    await t.test('manifest inside engine state is rejected', async () => {
      const supplied = join(state, 'trusted.json'); await writeFile(supplied, await readFile(manifest)); process.env.HEDDLE_TRUSTED_TEST_MANIFEST = supplied;
      try { assert.match((await withheld(await candidate())).summary, /inside engine state/); } finally { process.env.HEDDLE_TRUSTED_TEST_MANIFEST = manifest; }
    });
    await t.test('missing, symlinked, writable, and malformed operator manifests fail closed', async () => {
      const alias = join(root, 'manifest-alias'); await symlink(manifest, alias);
      const invalid = join(root, 'invalid.json'); await writeFile(invalid, '{}');
      const writable = join(root, 'writable.json'); await writeFile(writable, await readFile(manifest)); await chmod(writable, 0o666);
      for (const supplied of [join(root, 'missing.json'), alias, invalid, writable, 'relative.json']) {
        process.env.HEDDLE_TRUSTED_TEST_MANIFEST = supplied; await withheld(await candidate());
      }
      process.env.HEDDLE_TRUSTED_TEST_MANIFEST = manifest;
    });
    await t.test('no boolean environment bypass; unknown source remains withheld', async () => {
      const path = await candidate(); await writeFile(join(path, 'test.mjs'), '// unreviewed\n');
      process.env.HEDDLE_ALLOW_UNTRUSTED_TESTS = 'true';
      try { await withheld(path); } finally { delete process.env.HEDDLE_ALLOW_UNTRUSTED_TESTS; }
    });
    await t.test('fixture authoring rejects traversal and forbidden paths', () => {
      for (const path of ['../test.mjs', '/test.mjs', 'dir/../test.mjs', 'dir\\test.mjs', '.heddle/secret', 'node_modules/test.mjs', '.npmrc']) assert.throws(() => createReviewedFixtureEntry('bad', { [path]: 'no' }));
    });
    await t.test('candidate cannot be used as the operator npm cache', async () => {
      const base = join(root, 'cache-containment-proof'); await mkdir(base);
      const path = join(base, 'heddle-npm-cache'); await mkdir(path);
      for (const [name, contents] of Object.entries(source)) await writeFile(join(path, name), contents);
      const previous = process.env.TMPDIR; process.env.TMPDIR = base;
      try { assert.match((await withheld(path)).summary, /npm cache cannot be inside the candidate/); }
      finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
    });
    await t.test('symlinked or writable operator npm cache is withheld before npm', async () => {
      const base = join(root, 'cache-alias-proof'); await mkdir(base);
      const outside = join(root, 'outside-cache'); await mkdir(outside);
      const cache = join(base, 'heddle-npm-cache'); await symlink(outside, cache);
      const path = await candidate(), previous = process.env.TMPDIR; process.env.TMPDIR = base;
      try {
        assert.match((await withheld(path)).summary, /npm cache may not be a symlink/);
        await rm(cache); await mkdir(cache); await chmod(cache, 0o777);
        assert.match((await withheld(path)).summary, /unsafe source permissions/);
      } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
    });
  } finally {
    for (const [name, value] of [['HEDDLE_TRUSTED_TEST_MANIFEST', old.manifest], ['ENGINE_STATE_DIR', old.state], ['PATH', old.path]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
