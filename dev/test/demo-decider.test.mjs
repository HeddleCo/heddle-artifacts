// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoDecider } from '../../demo/lib/harness.mjs';

test('demo human defaults to Luke without an email and uses configured identity verbatim', () => {
  assert.deepEqual(demoDecider({}), { id: 'luke', displayName: 'Luke' });
  assert.deepEqual(demoDecider({ DEMO_DECIDER_ID: 'operator', DEMO_DECIDER_NAME: 'Operator', DEMO_DECIDER_EMAIL: 'operator@example.com' }),
    { id: 'operator', displayName: 'Operator', email: 'operator@example.com', sponsor: true });
});
