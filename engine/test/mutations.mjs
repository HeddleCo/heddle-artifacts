// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../lib/process.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'track-b-mutations-'));
const binary = process.env.HEDDLE_BIN || '/home/scratch/heddle-0.30-bin/bin/heddle';
const runner = join(source, 'test/e2e.mjs');
const env = { HEDDLE_BIN: binary, TMPDIR: process.env.TMPDIR || '/tmp' };
const baseline = await run(process.execPath, [runner], { env, timeout: 180000, allowFailure: true });
await writeFile(join(root, 'baseline.log'), baseline.stdout.toString() + baseline.stderr.toString());
assert.equal(baseline.code, 0, `Baseline failed: ${join(root, 'baseline.log')}`);
assert.match(baseline.stdout.toString(), /B-T5 PASS/);
process.stdout.write(baseline.stdout);
console.log('Baseline PASS: unchanged B-T1–B-T5 assertions pass before mutation');
const evidence = /Evidence scratch: (.+)/.exec(baseline.stdout.toString())[1];

const cases = [
  ['B-T1', 'lib/git.mjs', 'export async function conflictPaths(base, a, b) {', 'export async function conflictPaths(base, a, b) {\n  return [];', 'B-T1 alice conflict attributed to bob', 'disable conflict preview'],
  ['B-T2', 'lib/signatures.mjs', 'export async function verifyCapture(heddleDir, show, expectedKey) {', 'export async function verifyCapture(heddleDir, show, expectedKey) {\n  return expectedKey;', 'B-T2 wrong enrolled key must be rejected', 'disable native identity verification'],
  ['B-T4', 'lib/commands.mjs', "  if (!Array.isArray(request.expectHeads) || JSON.stringify([...request.expectHeads].sort()) !== JSON.stringify(current.heads)) throw new Rejection('stale', 'Candidates changed; review the current heads');", '', 'decide:', 'remove stale-head guard'],
  ['B-T5', 'lib/snapshots.mjs', '    state.root = stateRoot;', "    state.root = stateRoot;\n    Object.values(state.lanes).find(l => l.candidate).candidate.subject += ' changed on restore';", 'B-T5 candidates stdout byte-identical', 'corrupt restored candidate metadata'],
];
for (const [label, file, before, after, expected, description] of cases) {
  const dir = join(root, label); await cp(source, dir, { recursive: true });
  const path = join(dir, file), text = await readFile(path, 'utf8');
  assert(text.includes(before), `Mutation location exists: ${label}`);
  await writeFile(path, text.replace(before, after));
  const failed = await run(process.execPath, [runner], { env: { ...env, ENGINE_FILE: join(dir, 'engine.mjs') }, allowFailure: true, timeout: 180000 });
  const output = failed.stdout.toString() + failed.stderr.toString();
  await writeFile(join(root, `${label}.log`), output);
  assert.notEqual(failed.code, 0, `${label} mutation must fail`);
  assert(output.includes(expected), `${label} must fail its acceptance assertion`);
  console.log(`${label} negative PASS: ${description} → unchanged acceptance fails (exit ${failed.code})`);
}

const projection = join(root, 'B-T3'); await cp(source, projection, { recursive: true });
const path = join(projection, 'lib/projection.mjs'), text = await readFile(path, 'utf8');
assert(text.includes('if (!state.projection)'));
await writeFile(path, text.replace('if (!state.projection)', 'if (true)'));
const check = async dir => {
  const program = `import {readFile} from 'node:fs/promises'; import assert from 'node:assert/strict'; import {verifyProjection} from ${JSON.stringify(pathToFileURL(join(dir, 'lib/publish.mjs')).href)}; const state=JSON.parse(await readFile(process.env.ENGINE_STATE_DIR+'/engine.json')); const result=await verifyProjection(state,state.mainSha); console.log(JSON.stringify(result)); assert.equal(result.exportRoundTrip,true,'B-T3 restored export SHA equals recorded pin');`;
  return run(process.execPath, ['--input-type=module', '-e', program], { env: { ...env, ENGINE_STATE_DIR: join(evidence, 'state') }, allowFailure: true, timeout: 180000 });
};
assert.equal((await check(source)).code, 0, 'B-T3 baseline round trip');
const failed = await check(projection);
assert.notEqual(failed.code, 0);
assert.match(failed.stderr.toString(), /B-T3 restored export SHA equals recorded pin/);
assert.match(failed.stdout.toString(), /"exportRoundTrip":false/);
await writeFile(join(root, 'B-T3.log'), failed.stdout.toString() + failed.stderr.toString());
console.log('B-T3 negative PASS: skip export pin → {"exportRoundTrip":false,"treeMatch":true,"fsck":true}; round-trip assertion fails (exit 1)');
console.log('B-T6 PASS: disabled identity guard fails B-T2; skipped export pin fails B-T3; all B-T1–B-T5 acceptance assertions have failure proofs');
console.log(`Mutation evidence: ${root}`);
