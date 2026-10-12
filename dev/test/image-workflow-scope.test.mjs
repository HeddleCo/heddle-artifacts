// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('historical image recovery is manual-only and cannot claim to test a new app head', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/container-build.yml', import.meta.url), 'utf8');
  const events = workflow.split("'on':\n")[1]?.split('\npermissions:')[0];
  assert.ok(events, 'explicit event section');
  assert.match(events, /^  workflow_dispatch:/m);
  assert.doesNotMatch(events, /^  (?:push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /SOURCE_SHA: 98930ecfa8217b40c947bd566c8f9f90d1b51426/);
  assert.match(workflow, /SOURCE_TREE: 1d75e7c2847e8109ed324b1c7efd9b14314b2bab/);
  assert.match(workflow, /ref: \$\{\{ env\.SOURCE_SHA \}\}/);
  assert.match(workflow, /test "\$EXPECTED_SHA" = "\$SOURCE_SHA"/);
  assert.match(workflow, /test "\$GITHUB_RUN_ATTEMPT" = 1/);
  assert.match(workflow, /timeout-minutes: 60/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|id-token:\s*write|persist-credentials:\s*true/);
});
