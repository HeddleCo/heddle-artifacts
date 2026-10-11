// SPDX-License-Identifier: Apache-2.0
// Operator-only review aid. Never invoke this from ingest or use candidate input.
import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewedFixtureEntry } from '../engine/lib/trusted-tests.mjs';

const demo = new URL('../demo/', import.meta.url);
const files = ['README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'src/table.ts', 'test/table.test.ts'];
const seed = Object.fromEntries(await Promise.all(files.map(async path => [path, await readFile(new URL(`seed-project/${path}`, demo))])));
const trees = [createReviewedFixtureEntry('demo-seed', seed)];
for (const agent of ['alice', 'bob', 'carol']) {
  const source = { ...seed };
  if (agent === 'carol') source['README.md'] = await readFile(new URL('scripted-agents/carol.md', demo));
  else {
    source['src/table.ts'] = await readFile(new URL(`scripted-agents/${agent}.ts`, demo));
    source['test/escapes.test.ts'] = await readFile(new URL('scripted-agents/escapes.test.ts', demo));
  }
  trees.push(createReviewedFixtureEntry(`demo-${agent}`, source));
}

// These are immutable replays of the genuine-native-v1 published sources, not
// newly generated agent code. Original commits: scan 167c9385e04e1b9028588f6534b51c5e1c398494,
// parity 299f09558f9bb50b99127c122dcaa827a98752c1. See that evidence packet's
// REPORT.md, operator-approval.json and trusted-manifest.json (SHA-256
// 51267306fd342e5eee7623bfd48f05ed028b5a0130e65ad5a06b2f8ac5b621fc).
// Review was by an operator assistant, not a human; no baseline-regression trees
// are included. Fixed inventory checks reject extra files instead of harvesting
// arbitrary trees or silently ignoring changed executable modes.
for (const agent of ['native-scan', 'native-parity']) {
  const root = new URL(`evidence/genuine-native-v1/candidates/${agent}/`, demo);
  for (const [directory, names] of [
    ['', ['README.md', 'package-lock.json', 'package.json', 'src', 'test', 'tsconfig.json']],
    ['src/', ['table.ts']], ['test/', ['escapes.test.ts', 'table.test.ts']],
  ]) {
    const path = resolve(fileURLToPath(new URL(directory, root))), stat = await lstat(path);
    assert.ok(stat.isDirectory() && !(stat.mode & 0o7022), `${agent}: unsafe reviewed directory ${directory}`);
    assert.equal(await realpath(path), path, `${agent}: reviewed directory may not contain symlinks`);
    assert.deepEqual((await readdir(path)).sort(), names, `${agent}: reviewed inventory changed`);
  }
  const source = {};
  for (const file of [...files, 'test/escapes.test.ts']) {
    const path = new URL(file, root), stat = await lstat(path);
    assert.ok(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o7133), `${agent}: expected regular non-executable file ${file}`);
    source[file] = await readFile(path);
  }
  trees.push(createReviewedFixtureEntry(`genuine-${agent}`, source));
}

// --write only renders already-reviewed bytes. It must never bless source drift;
// changing any pin requires a new out-of-band complete-tree/dependency review.
const reviewedDigests = [
  ['demo-seed', '8a78510b257cf07e97359a3ec9285b9bf51ff6bb8ea1b35e348f36af56dea0e4'],
  ['demo-alice', '2c9cee9e95d2621dc82fbe212375c89a1613799903ff105ec850d6568a80f344'],
  ['demo-bob', '64561d23aae8435b6855705686853d87bc98a3a68aa97cf6380f93cd10ed79a8'],
  ['demo-carol', '5fc2e97e60b0826837216b37967741334b31ef0808459359c9a99557fb825d16'],
  ['genuine-native-scan', '266e3f9e01bb63cd2f4139b9a225b83557733d656520869f856f8c764c7aff61'],
  ['genuine-native-parity', 'd3782809f58026c35839bc7226d1b54e43d46e5fc7f6320a12b9b4b5fdb37287'],
];
assert.deepEqual(trees.map(({ name, sha256 }) => [name, sha256]), reviewedDigests,
  'Reviewed source digest drift: refusing to generate execution permission, including with --write.');
const output = JSON.stringify({ version: 1, purpose: 'Operator-reviewed public demo fixtures only. Changes require an out-of-band source and lockfile review; this is not a sandbox.', trees }, null, 2) + '\n';
const path = new URL('trusted-test-trees.json', demo);
if (process.argv.includes('--write')) {
  await writeFile(path, output, { mode: 0o644 });
  console.log(`Wrote review artifact ${fileURLToPath(path)}. Review its complete source trees before shipping.`);
} else {
  if (await readFile(path, 'utf8') !== output) throw new Error('Reviewed fixture manifest differs. Review source changes before explicitly regenerating it with --write.');
  console.log('Trusted fixture manifest matches four scripted demo trees and two pinned genuine-agent replay trees.');
}
