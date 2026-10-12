// SPDX-License-Identifier: Apache-2.0
// Mutate isolated copies; never modify the working implementation for evidence.
import { cp, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const mutations = [
  ['bypass schema/candidate validation', s => s.replace('if (isReview(result, agents) && result.model === REVIEW_MODEL &&', 'if (true &&')],
  ['remove labeled fallback', s => s.replace('model: "fallback",', 'model: REVIEW_MODEL,')],
  ['remove two retries', s => s.replace('attempt < 3', 'attempt < 1')],
];
for (const [name, mutate] of mutations) {
  const temp = await mkdtemp(join(tmpdir(), 'heddle-D-review-mutation-'));
  try {
    await cp('reviewer', temp, { recursive: true, filter: path => !path.includes('node_modules') });
    await symlink(resolve('reviewer/node_modules'), join(temp, 'node_modules'));
    const file = join(temp, 'reviewer.ts'); const original = await readFile(file, 'utf8');
    const changed = mutate(original); if (changed === original) throw new Error(`Mutation did not match: ${name}`);
    await writeFile(file, changed);
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [resolve('reviewer/node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1'], { cwd: temp });
      let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
      child.on('error', reject); child.on('close', code => resolvePromise({ code, output }));
    });
    if (result.code !== 1 || !/Tests\s+\d+ failed/.test(result.output)) throw new Error(`Mutation was not rejected by assertions: ${name}\n${result.output}`);
    console.log(`${name}: exit ${result.code}; ${result.output.match(/Tests\s+\d+ failed[^\n]*/)[0].trim()}`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
