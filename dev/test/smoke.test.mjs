// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRefs } from '../smoke-artifacts.mjs';
test('A-S1 ref evidence cannot pass with a missing ref or a substring match', () => {
  const refs = `${'a'.repeat(40)}\trefs/heads/main\n${'b'.repeat(40)}\trefs/notes/heddle-why\n`;
  requireRefs(refs, ['refs/heads/main', 'refs/notes/heddle-why']);
  assert.throws(() => requireRefs(refs, ['refs/heads/candidates/x/y']), /ref_check_failed/);
  assert.throws(() => requireRefs(refs, ['refs/notes/heddle']), /ref_check_failed/);
});
