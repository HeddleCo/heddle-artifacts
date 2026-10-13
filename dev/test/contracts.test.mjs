// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import { emptyState, executeFixture } from '../stub-engine.mjs';
const schema = JSON.parse(await readFile(new URL('../../contracts/engine.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false }); ajv.addSchema(schema);
const sha = 'a'.repeat(40), state = emptyState();
const commands = {
  init: { opId: 'init', project: 'p', canonical: { remote: 'http://local/p' }, seed: { template: 'demo' } },
  'task.create': { opId: 'task', task: 't', intent: 'test' },
  'agent.enroll': { opId: 'enroll', agent: { id: 'alice', kind: 'agent', displayName: 'Alice' } },
  'lane.open': { opId: 'lane', task: 't', agent: 'alice' },
  ingest: { opId: 'ingest', items: [{ task: 't', agent: 'alice', fork: { remote: 'http://local/fork' }, ref: 'refs/heads/main', sha }], runTests: true },
  'tests.record': { opId: 'tests', task: 't', agent: 'alice', sourceSha: sha, run: { sourceSha: sha, treeSha: sha, output: '# pass 14\n# fail 0\n', durationMs: 10, installExitCode: 0, testExitCode: 0 } },
  candidates: { task: 't' }, captures: { task: 't' }, diff: { task: 't', agent: 'alice', maxBytes: 524288 },
  discuss: { opId: 'turn', task: 't', author: 'alice', body: 'why' },
  decide: { opId: 'decide', task: 't', decider: 'alice', pick: 'alice', rationale: 'why', expectHeads: [] },
  publish: { opId: 'publish', canonical: { remote: 'http://local/p' } }, why: { sha }, selftest: {}, loaded: {}
};
test('§7 schema accepts every JSON fixture command/output and rejects missing opId, extra credentials and unknown verbs', () => {
  for (const [command, input] of Object.entries(commands)) {
    if (command === 'decide') input.expectHeads = Object.values(state.candidates).map(c => c.state);
    const validateInput = ajv.getSchema(`${schema.$id}#/$defs/${command}.input`);
    assert.equal(validateInput(input), true, `${command} input: ${JSON.stringify(validateInput.errors)}`);
    assert.equal(ajv.validate(schema.$id, { command, input }), true);
    const result = executeFixture(state, command, input), validateOutput = ajv.getSchema(`${schema.$id}#/$defs/${command}.output`);
    assert.equal(validateOutput(result), true, `${command} output: ${JSON.stringify(validateOutput.errors)}`);
    if (input.opId) { const bad = { ...input }; delete bad.opId; assert.equal(validateInput(bad), false, `${command} must require opId`); }
    assert.equal(validateInput({ ...input, ARTIFACTS_WRITE_TOKEN: 'fixture-only' }), false, 'tokens belong only in env');
  }
  assert.equal(ajv.validate(schema.$id, { command: 'unknown', input: {} }), false);
  console.log('§7 schema: 15 JSON commands/results accepted; missing opId, stdin credentials and unknown commands rejected');
});
