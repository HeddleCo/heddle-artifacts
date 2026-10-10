// SPDX-License-Identifier: Apache-2.0
// Isolated mutation proof for publication evidence; never changes working sources.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const source = await readFile(new URL('../src/verification.ts', import.meta.url), 'utf8');
const tests = await readFile(new URL('./verification.test.mjs', import.meta.url), 'utf8');
const mutations = [
  ['remove exact SHA binding', 'view.sha !== requestedSha || verify.sha !== requestedSha ||', ''],
  ['ignore failed publication checks', 'verify.exportRoundTrip && verify.treeMatch && verify.fsck', 'true'],
  ['accept malformed boolean values', "!['exportRoundTrip', 'treeMatch', 'fsck'].every(key => typeof verify[key as keyof PublicationVerification] === 'boolean') ||", ''],
];
for (const [name, before, replacement] of mutations) {
  const dir = await mkdtemp(join(tmpdir(), 'heddle-ui-verification-mutation-'));
  try {
    if (source.split(before).length !== 2) throw new Error(`Mutation must match once: ${name}`);
    await mkdir(join(dir, 'src')); await mkdir(join(dir, 'test'));
    await writeFile(join(dir, 'src', 'verification.ts'), source.replace(before, replacement));
    await writeFile(join(dir, 'test', 'verification.test.mjs'), tests);
    const result = spawnSync(process.execPath, ['--test', join(dir, 'test', 'verification.test.mjs')], { encoding: 'utf8' });
    const output = result.stdout + result.stderr;
    if (result.status !== 1 || !output.includes('AssertionError')) throw new Error(`Mutation not rejected by assertion: ${name}\n${output}`);
    console.log(`${name}: rejected, exit ${result.status}; ${output.match(/(?:ℹ|#) fail \d+/)?.[0]}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
