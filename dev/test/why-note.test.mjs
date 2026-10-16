// SPDX-License-Identifier: Apache-2.0
// The why note is read in `git log --notes`: the person's decision and reason lead, the signed proofs trail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrative } from '../../engine/lib/why.mjs';

const sha = n => n.toString(16).padStart(40, '0');
const proof = { publicKey: 'a'.repeat(64), payload: 'x'.repeat(2000), signature: 'b'.repeat(128) };
const candidate = (agent, n) => ({ task: 't', agent, sourceSha: sha(n), conflicts: [{ path: 'src/table.ts', region: 'parseRow', with: [] }], signedBy: `${agent}-key`,
  tests: { status: 'pass', passed: 15, failed: 0, provenance: 'local run (not isolated)', observation: proof } });
const state = {
  tasks: { t: { intent: 'Support escaped pipes' } },
  agents: { alice: { displayName: 'alice' }, bob: { displayName: 'bob' }, 'luke-judge': { displayName: 'Luke Judge', publicKey: 'c'.repeat(64) } },
  lanes: { 't/alice': { task: 't', candidate: candidate('alice', 1) }, 't/bob': { task: 't', candidate: candidate('bob', 2) } },
  turns: [{ id: 'turn-1', task: 't', author: 'luke-judge', kind: 'human', body: 'bob keeps the API' }],
  attestations: { 'turn-1': proof, 'decision-1': proof }, decisionAttestations: { t: 'decision-1' },
};
const decision = { pick: 'bob', decider: 'luke-judge', rationale: 'Bob keeps parseRow returning string[].', resolutionState: 'r', landState: 'l' };

test('the decision and its reason come right after the intent, by the decider’s name', () => {
  const lines = narrative(state, 't', decision).split('\n');
  assert.deepEqual(lines.slice(0, 4), ['Heddle decision · task t', 'Intent:    Support escaped pipes',
    'Decision:  bob landed, chosen by Luke Judge (luke-judge)', 'Rationale: Bob keeps parseRow returning string[].']);
  assert.ok(lines.some(line => /^Chosen:\s+bob /.test(line)) && lines.some(line => /^Rejected:\s+alice /.test(line)), 'git-log checks still find chosen and rejected');
  assert.ok(lines.includes('Discussion: Luke Judge (luke-judge): bob keeps the API'));
  assert.match(lines.find(line => line.startsWith('Decided by')), /^Decided by Luke Judge \(luke-judge\) ed25519:c{64}/);
});

test('every signed proof is kept, after all the human-readable lines', () => {
  const lines = narrative(state, 't', decision).split('\n'), first = lines.findIndex(line => / proof: /.test(line));
  assert.deepEqual(lines.filter(line => / proof: /.test(line)).map(line => line.split(':')[0]), ['Test proof', 'Test proof', 'Turn proof', 'Decision proof']);
  assert.ok(lines.slice(first).every(line => / proof: \{/.test(line)), 'nothing readable after the proofs begin');
  assert.ok(lines.slice(0, first).join('\n').length < 1200, 'the readable part fits on a screen');
});

test('an undecided candidate note has no decision lines', () => {
  const text = narrative(state, 't');
  assert.doesNotMatch(text, /^Decision:|^Rationale:|^Decided by/m);
  assert.match(text, /^Candidate:\s+alice/m);
});
