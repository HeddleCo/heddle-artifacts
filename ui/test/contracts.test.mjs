// SPDX-License-Identifier: Apache-2.0
// In-process fixture HTTP/reducer checks; these do not claim real Worker or browser acceptance.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const temp = await mkdtemp(join(tmpdir(), 'heddle-ui-contracts-'));
after(() => rm(temp, { recursive: true, force: true }));
await build({ entryPoints: { mock: fileURLToPath(new URL('../mock-api.ts', import.meta.url)), feed: fileURLToPath(new URL('../src/feed.ts', import.meta.url)) }, outdir: temp, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
const { createMock } = await import(pathToFileURL(join(temp, 'mock.mjs')));
const { updateBoard, updateTask } = await import(pathToFileURL(join(temp, 'feed.mjs')));
const api = (mock, path, body) => mock.handle(new Request(`http://fixture.invalid${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const taskPath = '/api/projects/demo/tasks/parser-escapes';
test('fixture board and task share canonical candidate/state shapes', async () => {
  const mock = createMock();
  const project = await (await api(mock, '/api/projects/demo')).json();
  const task = await (await api(mock, taskPath)).json();
  assert.equal(project.tasks.reduce((n, t) => n + t.lanes.length, 0), 3);
  assert.deepEqual(task.heads, task.candidates.map(candidate => candidate.state));
  assert.deepEqual(project.tasks[0].candidates, task.candidates);
});
test('fixture rejects stale heads and accepts the exact reviewed decision', async () => {
  const mock = createMock();
  const task = await (await api(mock, taskPath)).json();
  const decision = { pick: 'bob', rationale: 'Preserve the API.', decider: 'luke', expectHeads: task.heads };
  assert.equal((await api(mock, `${taskPath}/decision`, { ...decision, expectHeads: [] })).status, 409);
  const response = await api(mock, `${taskPath}/decision`, decision);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pick, 'bob');
});
test('fixture preserves explicit missing verification and fallback fields', async () => {
  const mock = createMock('decided');
  const response = await api(mock, `/api/projects/demo/why/${'f'.repeat(40)}`);
  assert.equal(response.status, 200);
  const why = await response.json();
  assert.equal(why.verify, undefined);
  assert.match(why.narrative, /Chosen:    bob/);
});
test('fixture signed human discussion retains author and reply anchor', async () => {
  const mock = createMock();
  const response = await api(mock, `${taskPath}/turns`, { body: 'Preserve the API.', as: 'luke', replyTo: 'turn-review' });
  assert.equal(response.status, 200);
  const turn = await response.json();
  assert.equal(turn.author, 'luke'); assert.equal(turn.replyTo, 'turn-review');
  assert.equal(turn.kind, 'human'); assert.ok(turn.signedBy);
});
test('live reducers retain independent lanes and deduplicate repeated turns', async () => {
  const mock = createMock();
  const project = await (await api(mock, '/api/projects/demo')).json();
  const task = await (await api(mock, taskPath)).json();
  const candidate = { ...task.candidates[1], state: 'new-bob-state' };
  const board = updateBoard(project, { type: 'candidate.ready', candidate });
  assert.equal(board.tasks[0].candidates.length, 2);
  assert.equal(board.tasks[0].candidates.find(c => c.agent === 'bob').state, 'new-bob-state');
  assert.deepEqual(board.tasks[1], project.tasks[1]);
  const turn = { ...task.turns[0], body: 'Updated context.' };
  const event = { type: 'discussion.posted', turn };
  assert.equal(updateTask(updateTask(task, event), event).turns.filter(t => t.id === turn.id).length, 1);
});
test('fixture API errors are returned as HTTP outcomes', async () => {
  const mock = createMock();
  assert.equal((await api(mock, '/api/projects/unknown')).status, 404);
  await api(mock, '/__mock/reset', { fixture: 'conflict', decisionStatus: 403 });
  assert.equal((await api(mock, `${taskPath}/decision`, {})).status, 403);
});

test('failed publication keeps the recorded decision immutable and retryable', async () => {
  const mock = createMock();
  await api(mock, '/__mock/reset', { fixture: 'conflict', decisionStatus: 502 });
  const initial = await (await api(mock, taskPath)).json();
  const body = { pick: 'bob', decider: 'luke', rationale: '  Signed rationale stays exact.\n', expectHeads: initial.heads };
  assert.equal((await api(mock, `${taskPath}/decision`, body)).status, 502);
  const pending = await (await api(mock, taskPath)).json();
  assert.equal(pending.decision.mainSha, '');
  assert.equal(pending.decision.rationale, body.rationale);
  await api(mock, '/__mock/decision-status', { decisionStatus: 200 });
  const changed = await api(mock, `${taskPath}/decision`, { ...body, rationale: body.rationale.trim() });
  assert.equal(changed.status, 409); assert.equal((await changed.json()).error, 'decision_in_progress');
  const retried = await api(mock, `${taskPath}/decision`, { ...body, expectHeads: pending.heads });
  assert.equal(retried.status, 200); assert.match((await retried.json()).mainSha, /^[a-f0-9]{40}$/);
});
