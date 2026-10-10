// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicationEvidence } from '../src/verification.ts';
const sha = 'f'.repeat(40);
const verify = { sha, exportRoundTrip: true, treeMatch: true, fsck: true, checkedAt: '2026-10-10T20:00:00.000Z' };
const view = { sha, narrative: 'Decision', verify };
test('only exact-SHA complete publication evidence passes', () => {
  assert.equal(publicationEvidence(view, sha)?.passed, true);
});
test('a missing API verification stays unavailable', () => {
  assert.equal(publicationEvidence(undefined, sha), undefined);
  assert.equal(publicationEvidence({ sha, narrative: 'Decision' }, sha), undefined);
});
test('reject verification for another SHA and responses for another route', () => {
  assert.equal(publicationEvidence({ ...view, verify: { ...verify, sha: 'a'.repeat(40) } }, sha), undefined);
  assert.equal(publicationEvidence({ ...view, sha: 'a'.repeat(40) }, sha), undefined);
});
for (const key of ['exportRoundTrip', 'treeMatch', 'fsck']) test(`${key} must be a boolean and false must fail`, () => {
  assert.equal(publicationEvidence({ ...view, verify: { ...verify, [key]: false } }, sha)?.passed, false);
  for (const value of [undefined, 'true', 1, null]) assert.equal(publicationEvidence({ ...view, verify: { ...verify, [key]: value } }, sha), undefined);
});
test('malformed publication timestamp does not claim verification', () => {
  for (const checkedAt of [undefined, '', 'not a timestamp']) assert.equal(publicationEvidence({ ...view, verify: { ...verify, checkedAt } }, sha), undefined);
});
