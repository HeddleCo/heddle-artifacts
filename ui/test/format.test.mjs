// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName, plural, runnerLabel, combinedTestedNote } from '../src/format.ts';

test('lane counts read naturally', () => {
  assert.equal(plural(1, 'lane'), '1 lane');
  assert.equal(plural(2, 'lane'), '2 lanes');
  assert.equal(plural(0, 'lane'), '0 lanes');
});
test('attributions show the person, not their email', () => {
  assert.equal(displayName('Luke <luke@heddle-artifacts.local>'), 'Luke');
  assert.equal(displayName('Rehearsal operator (Claude, not Luke) <op@x.local>'), 'Rehearsal operator (Claude, not Luke)');
  assert.equal(displayName('Luke'), 'Luke');
  assert.equal(displayName('<only@email>'), '<only@email>');
});

test('the runner label is shown once tests have run, never while they are pending, and is whatever the run reported', () => {
  assert.equal(runnerLabel({ status: 'pass', provenance: 'local run (not isolated)' }), 'local run (not isolated)');
  assert.equal(runnerLabel({ status: 'fail', provenance: 'isolated sandbox' }), 'isolated sandbox');
  assert.equal(runnerLabel({ status: 'error', provenance: 'isolated sandbox (local fixture)' }), 'isolated sandbox (local fixture)');
  assert.equal(runnerLabel({ status: 'pending', provenance: 'isolated sandbox' }), undefined, 'a pending test has not run anywhere yet');
  assert.equal(runnerLabel({ status: 'pass' }), undefined); assert.equal(runnerLabel(undefined), undefined);
});
test('the combined-check note names the runner that tested the merged result, or none', () => {
  assert.match(combinedTestedNote({ status: 'pass', provenance: 'local run (not isolated)' }), /local run \(not isolated\)/);
  assert.doesNotMatch(combinedTestedNote({ status: 'pass', provenance: 'local run (not isolated)' }), /isolated sandbox/i);
  assert.match(combinedTestedNote({ status: 'pass', provenance: 'isolated sandbox' }), /isolated sandbox/);
  assert.doesNotMatch(combinedTestedNote({ status: 'pending', provenance: 'isolated sandbox' }), /isolated sandbox/i);
  assert.doesNotMatch(combinedTestedNote(undefined), /isolated sandbox|local/i);
});
