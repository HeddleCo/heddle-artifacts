// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionOptions } from '../../engine/lib/decision-anchor.mjs';
import { emptyState, executeFixture } from '../stub-engine.mjs';

test('preflight uses the chosen tree or its combined tree, including added and deleted files', () => {
  const state = emptyState();
  state.tasks.t = { baseSha: 'old-main' };
  state.candidates['t/a'] = { task: 't', agent: 'a', sourceSha: 'source', treeSha: 'candidate-tree', combined: { treeSha: 'combined-tree' } };
  state.treeFiles = { 'candidate-tree': ['src/added.ts'], 'combined-tree': ['src/added.ts', 'src/from-main.ts'] };
  assert.deepEqual(executeFixture(state, 'decision.validate', { task: 't', pick: 'a', anchor: 'src/from-main.ts:parseRow' }), { valid: true });
  assert.equal(executeFixture(state, 'decision.validate', { task: 't', pick: 'a', anchor: 'README.md' }).error.code, 'invalid_anchor');
  state.containsMain = ['source'];
  assert.equal(executeFixture(state, 'decision.validate', { task: 't', pick: 'a', anchor: 'src/from-main.ts' }).error.code, 'invalid_anchor');
  assert.deepEqual(executeFixture(state, 'decision.validate', { task: 't', pick: 'a', anchor: 'src/added.ts' }), { valid: true });
});
test('identifier and tag validation reject trailing newlines and preserve allowed punctuation', () => {
  for (const anchor of ['src/table.ts:parseRow\n', 'src/table.ts:parseRow()', 'src/table.ts:Class.method'])
    assert.throws(() => decisionOptions({ anchor }), { code: 'invalid_anchor' });
  for (const tags of [['valid\n'], ['x'.repeat(65)], Array(9).fill('x')])
    assert.throws(() => decisionOptions({ tags }), { code: 'invalid_tags' });
  assert.deepEqual(decisionOptions({ anchor: 'src/table.ts:$parse_row2', tags: ['_.:/-', 'x'.repeat(64)] }), { path: 'src/table.ts', symbol: '$parse_row2' });
});
