// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName, plural } from '../src/format.ts';

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
