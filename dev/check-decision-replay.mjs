// SPDX-License-Identifier: Apache-2.0
// Post-run local verification. Raw snapshots remain private and never get logged.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rename, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../engine/lib/process.mjs';

const root = resolve(process.argv[2] || '../decision-replay-v1');
const evidence = join(root, 'evidence');
const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'));
const ready = JSON.parse(await readFile(join(evidence, 'ready.json'), 'utf8'));
assert.equal(result.runKind, 'historical-candidate-decision-replay');
const original = join(root, 'private', 'engine', ready.project);
const restored = await mkdtemp(join(root, 'private', 'restored-engine-'));
const parked = original + '.offline-for-restore';
const binary = process.env.HEDDLE_BIN;
assert.ok(binary, 'Use the verified stock HEDDLE_BIN');
const env = target => ({ ENGINE_STATE_DIR: target, HEDDLE_BIN: binary, TMPDIR: process.env.TMPDIR });
const stateModule = pathToFileURL(resolve('engine/lib/state.mjs')).href;
const projectionModule = pathToFileURL(resolve('engine/lib/projection.mjs')).href;
const script = `import {load} from ${JSON.stringify(stateModule)}; import {exportProjection} from ${JSON.stringify(projectionModule)};
const state=await load(),decision=state.decisions['parser-escapes'];
const turn=state.turns.filter(t=>t.author===decision.decider&&t.body===decision.rationale).at(-1);
const first=await exportProjection(state),second=await exportProjection(state);
console.log(JSON.stringify({decisionAt:decision.at,projectionAt:state.projection.at,rationaleTurn:turn,first,second}));`;
async function exportTwice(target) {
  const output = await run(process.execPath, ['--input-type=module', '-e', script], { env: env(target) });
  const value = JSON.parse(output.stdout);
  assert.equal(value.decisionAt, result.decision.at);
  assert.equal(value.projectionAt, value.decisionAt);
  assert.equal(value.rationaleTurn.at, value.decisionAt);
  assert.equal(value.first.sha, result.main); assert.deepEqual(value.first, value.second);
  assert.equal(value.first.tree, result.mainTree);
  return value;
}
const before = await exportTwice(original);
assert.ok(Date.parse(result.decision.at) > Date.parse(result.reviewTurn.at));
assert.ok(Date.parse(result.verification.checkedAt) >= Date.parse(result.decision.at));
const gitTime = (await run('git', ['show', '-s', '--format=%ct', 'main'], { cwd: join(root, 'private', 'proof') })).stdout.toString().trim();
assert.equal(Number(gitTime), Math.floor(Date.parse(result.decision.at) / 1000));
const engine = resolve('engine/engine.mjs');
const snapshot = (await run(process.execPath, [engine, 'snapshot'], { input: '{}', env: env(original), maxBytes: 128 * 1024 * 1024 })).stdout;
await writeFile(join(root, 'private', 'decision-replay.snapshot.zst'), snapshot, { mode: 0o600 });
let after;
await rename(original, parked);
try {
  await run(process.execPath, [engine, 'restore'], { input: snapshot, env: env(restored) });
  after = await exportTwice(restored);
  assert.deepEqual(after, before);
  await assert.rejects(access(original), { code: 'ENOENT' });
} finally { await rename(parked, original); }
const proof = { checkedAt: new Date().toISOString(), passed: true, main: result.main,
  decisionAt: result.decision.at, nativeRationaleTurnAt: before.rationaleTurn.at,
  nativeRationaleOperationId: before.rationaleTurn.id, reviewerTurnAt: result.reviewTurn.at,
  publicationCheckedAt: result.verification.checkedAt, gitCommitEpochSeconds: Number(gitTime),
  repeatedOriginalExports: [before.first.sha, before.second.sha],
  repeatedRestoredExports: [after.first.sha, after.second.sha],
  projectionTimestampPreserved: true, exactNativeRationalePreserved: true,
  originalStateUnavailableDuringRestoredExports: true,
  limits: ['This is a replay of historical genuine candidates/reviewer text; no new coding or reviewer session.', 'Snapshot and restored custodial state remain private and excluded from evidence.'] };
await writeFile(join(evidence, 'decision-time-stability.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
console.log(`DECISION TIME / RESTORE PASS: ${result.decision.at}; four stable exports of ${result.main}`);
