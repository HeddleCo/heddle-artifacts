// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTestCounts, isolatedTestResult, TEST_OUTPUT_BYTES } from '../../engine/lib/isolated-tests.mjs';

const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'isolated-tests-'));
process.env.ENGINE_STATE_DIR = join(root, 'engine');
const { recordTests, decide } = await import('../../engine/lib/commands.mjs');
const { verifyAttestation } = await import('../../engine/lib/attestations.mjs');
const { testCandidate } = await import('../../engine/lib/tests.mjs');
const { narrative } = await import('../../engine/lib/why.mjs');
const sha = n => n.toString(16).padStart(40, '0');
const run = overrides => ({ sourceSha: sha(1), treeSha: sha(3), output: '# pass 14\n# fail 0\n', installExitCode: 0, testExitCode: 0, durationMs: 10, ...overrides });
const state = (sourceSha = sha(1)) => {
  const candidate = { task: 'task', agent: 'alice', sourceSha, treeSha: sha(3), state: 'native-capture', conflicts: [], signedBy: 'agent-key', tests: { status: 'pending', provenance: 'isolated sandbox' } };
  return { project: 'project', tasks: { task: { intent: 'Improve parser' } }, agents: { alice: { id: 'alice' }, human: { id: 'human' } },
    lanes: { 'task/alice': { task: 'task', agent: 'alice', status: 'active', candidate, seen: {} } }, decisions: {}, turns: [], narratives: {} };
};
const request = overrides => ({ task: 'task', agent: 'alice', sourceSha: sha(1), run: run(), ...overrides });

test('parses observed Node and Vitest totals, including mixed failures and ANSI', () => {
  for (const [output, counts] of [
    ['# pass 14\n# fail 0\n', { passed: 14, failed: 0 }],
    ['ℹ pass 15\nℹ fail 3\n', { passed: 15, failed: 3 }],
    [' Tests  3 failed | 15 passed (18)\n', { passed: 15, failed: 3 }],
    ['\x1b[32m Tests  18 passed (18)\x1b[0m\n', { passed: 18, failed: 0 }],
    [' Tests  18 failed (18)\n', { passed: 0, failed: 18 }],
  ]) assert.deepEqual(parseTestCounts(output), counts);
  for (const output of ['', '{"passed":18,"failed":0}', 'a test passed', '# pass -1\n', '# pass 999999999999\n']) assert.equal(parseTestCounts(output), undefined);
  assert.equal(isolatedTestResult(run({ output: '# pass 0\n# fail 0\n' })).status, 'error');
  assert.equal(isolatedTestResult(run({ output: '# pass 12\n# fail 2\n', testExitCode: 1 })).status, 'fail');
  assert.equal(isolatedTestResult(run({ passed: 9999, failed: 0 })).passed, 14);
  assert.equal(isolatedTestResult(run({ fixture: true })).provenance, 'isolated sandbox (local fixture)');
});
test('sandbox timeout and failures cannot become pass even with passing output', async () => {
  for (const overrides of [{ failure: 'timeout' }, { durationMs: 180000 }, { testExitCode: 124 }, { testExitCode: 137 },
    { failure: 'sandbox' }, { failure: 'checkout' }, { failure: 'output' }, { installExitCode: 1 }, { output: 'x'.repeat(TEST_OUTPUT_BYTES + 1) }]) {
    const s = state(), result = await recordTests(s, request({ run: run(overrides) }));
    assert.equal(result.candidate.tests.status, 'error', JSON.stringify(overrides));
    assert.equal(result.candidate.tests.passed, 0);
    assert.equal(result.candidate.tests.failed, 0);
  }
});
test('sandbox pass for SHA X is ignored for SHA Y even when their tree is identical', async () => {
  const s = state(sha(2)), result = await recordTests(s, request());
  assert.equal(result.ignored, true);
  assert.equal(s.lanes['task/alice'].candidate.tests.status, 'pending');
  assert.equal(s.lanes['task/alice'].candidate.sourceSha, sha(2));
});
test('sandbox observation is engine signed and binds SHA, tree and native state', async () => {
  const s = state(), result = await recordTests(s, request());
  const tests = result.candidate.tests;
  assert.equal(tests.status, 'pass'); assert.equal(tests.passed, 14);
  const proof = tests.observation;
  assert.equal(verifyAttestation(proof, proof.publicKey), proof.publicKey);
  const payload = JSON.parse(proof.payload);
  assert.equal(payload.sourceSha, sha(1)); assert.equal(payload.treeSha, sha(3)); assert.equal(payload.state, 'native-capture');
  assert.equal(payload.tests.provenance, 'isolated sandbox');
  assert.throws(() => verifyAttestation({ ...proof, payload: proof.payload.replace(sha(1), sha(2)) }, proof.publicKey));
  assert.match(narrative(s, 'task'), /isolated sandbox/);
  assert.match(narrative(s, 'task'), /Test proof:/);
  assert.equal((await recordTests(s, request())).ignored, true);
});
test('mismatched runner SHA or tree cannot be signed', async () => {
  for (const overrides of [{ sourceSha: sha(2) }, { treeSha: sha(2) }]) {
    const s = state(); await assert.rejects(recordTests(s, request({ run: run(overrides) })), { code: 'test_binding_mismatch' });
    assert.equal(s.lanes['task/alice'].candidate.tests.status, 'pending');
  }
});
test('engine decision waits for pending isolated observations', async () => {
  await assert.rejects(decide(state(), { task: 'task', decider: 'human', pick: 'alice', expectHeads: ['native-capture'], rationale: 'Pick' }), { code: 'tests_pending' });
});
test('unreviewed candidate never invokes npm in the signing engine', async () => {
  const candidate = join(root, 'unreviewed'), bin = join(root, 'bin');
  await mkdir(candidate); await mkdir(bin);
  await writeFile(join(candidate, 'package.json'), '{"scripts":{"test":"exit 0"}}');
  const marker = join(root, 'npm-called');
  await writeFile(join(bin, 'npm'), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  try {
    const result = await testCandidate(candidate); assert.equal(result.status, 'skipped'); assert.match(result.summary, /Tests withheld/);
    const { access } = await import('node:fs/promises'); await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally { process.env.PATH = previous; }
});
test.after(async () => { await rm(root, { recursive: true, force: true }); });
