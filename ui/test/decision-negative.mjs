// SPDX-License-Identifier: Apache-2.0
// Isolated mutation proof; the working UI sources remain unchanged.
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const source = await readFile(new URL('../src/decision.ts', import.meta.url), 'utf8');
const mutations = [
  ['accept pending decision as published', 'return !!decision && /^[a-f0-9]{40}$/i.test(decision.mainSha);', 'return !!decision;'],
  ['replace signed choice with editable draft', 'view.decision ?? { ...draft, rationale: draft.rationale.trim() }', '{ ...draft, rationale: draft.rationale.trim() }'],
  ['drop reviewed heads from publication retry', 'expectHeads: [...view.heads]', 'expectHeads: []'],
];
for (const [name, before, replacement] of mutations) {
  const dir = await mkdtemp(join(tmpdir(), 'heddle-ui-decision-mutation-'));
  try {
    if (source.split(before).length !== 2) throw new Error(`Mutation must match once: ${name}`);
    await mkdir(join(dir, 'src')); await mkdir(join(dir, 'test'));
    await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(dir, 'node_modules'));
    await writeFile(join(dir, 'src', 'decision.ts'), source.replace(before, replacement));
    await copyFile(new URL('../src/decision-notice.tsx', import.meta.url), join(dir, 'src', 'decision-notice.tsx'));
    await copyFile(new URL('./decision.test.mjs', import.meta.url), join(dir, 'test', 'decision.test.mjs'));
    const result = spawnSync(process.execPath, ['--test', join(dir, 'test', 'decision.test.mjs')], { encoding: 'utf8' });
    const output = result.stdout + result.stderr;
    if (result.status !== 1 || !output.includes('AssertionError')) throw new Error(`Mutation not rejected by assertion: ${name}\n${output}`);
    console.log(`${name}: rejected, exit ${result.status}; ${output.match(/(?:ℹ|#) fail \d+/)?.[0]}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
