// SPDX-License-Identifier: Apache-2.0
// Remove just history/semantic behavior, prove the real-engine assertions fail, restore exact bytes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const file = new URL('../engine/lib/captures.mjs', import.meta.url), original = await readFile(file, 'utf8');
const run = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', 'engine/test/captures.mjs'], { env: process.env });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  child.on('error', reject); child.on('close', code => resolve({ code, output }));
});
const mutations = [
  ['latest candidate only', 'Object.values(lane.seen || {})', '(lane.candidate ? [lane.candidate] : [])', 'all three pushes, not just the latest candidate'],
  ['semantic diff disabled', "const result = await heddle(['diff',", "throw new Error('semantic_disabled'); const result = await heddle(['diff',", "'unavailable'"]
];
try {
  for (const [name, before, after, expected] of mutations) {
    assert.ok(original.includes(before));
    await writeFile(file, original.replace(before, after));
    const result = await run();
    console.log(`Negative case: ${name}\n${result.output}`);
    assert.notEqual(result.code, 0, `${name}: tests must fail`);
    assert.ok(result.output.includes(expected), `${name}: expected a behavior assertion failure`);
  }
} finally { await writeFile(file, original); }
const restored = await run(); console.log(`Restored history/semantic code\n${restored.output}`); assert.equal(restored.code, 0);
