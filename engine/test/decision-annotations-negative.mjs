// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/process.mjs';

const root = await mkdtemp(join(tmpdir(), 'decision-annotations-negative-'));
const source = fileURLToPath(new URL('../', import.meta.url));
try {
  await cp(source, join(root, 'engine'), { recursive: true });
  const file = join(root, 'engine/lib/commands.mjs');
  const original = await readFile(file, 'utf8');
  const anchored = 'author: request.decider, body: request.rationale, anchor });';
  const tagged = "...(request.tags ?? []).map(tag => `--tag=${tag}`), ";
  assert.ok(original.includes(anchored) && original.includes(tagged), 'both decision changes exist before reverting');
  // Restore the original decide -> discuss call and resolve arguments in an isolated copy.
  await writeFile(file, original.replace(anchored, 'author: request.decider, body: request.rationale });').replace(tagged, ''));
  const result = await run(process.execPath, [fileURLToPath(new URL('./decision-annotations.mjs', import.meta.url)), '--anchored-only'], {
    env: { HEDDLE_BIN: process.env.HEDDLE_BIN || 'heddle', ENGINE_FILE: join(root, 'engine/engine.mjs') }, allowFailure: true,
  });
  const output = result.stdout.toString() + result.stderr.toString();
  process.stdout.write(output);
  assert.notEqual(result.code, 0, 'reverting the engine anchor/tag change must fail');
  assert.match(output, /anchored rationale annotation exists at src\/table.ts:parseRow/);
  console.log(`PASS negative case: reverted engine anchor/tag forwarding → anchored annotation assertion fails (exit ${result.code})`);
} finally {
  await rm(root, { recursive: true, force: true });
}
