// SPDX-License-Identifier: Apache-2.0
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import renderToString from 'preact-render-to-string';
import { isPublished, decisionRequest, conflictMessage } from '../src/decision.ts';
import { updateBoard, updateTask } from '../src/feed.ts';
const pending = { task: 'parser-escapes', pick: 'bob', decider: 'luke', rationale: '  Keep exact signed rationale.\n', mainSha: '', alternatives: ['alice'], resolutionState: 'resolution', landState: 'land', at: '2026-10-10T20:00:00Z' };
const view = { task: { slug: 'parser-escapes' }, candidates: [], turns: [], decision: pending, heads: ['alice-state', 'bob-state'] };
const draft = { pick: 'alice', decider: 'different-person', rationale: 'Replace the choice' };
test('only a complete commit SHA establishes publication', () => {
  for (const mainSha of ['', 'pending', 'f'.repeat(39), 'x'.repeat(40)]) assert.equal(isPublished({ ...pending, mainSha }), false);
  assert.equal(isPublished(undefined), false);
  assert.equal(isPublished({ ...pending, mainSha: 'f'.repeat(40) }), true);
});
test('retry preserves exact recorded choice, signer and rationale with current heads', () => {
  const body = decisionRequest(view, draft);
  assert.deepEqual(body, { pick: 'bob', decider: 'luke', rationale: pending.rationale, expectHeads: view.heads });
  assert.notEqual(body.expectHeads, view.heads);
});
test('published decisions cannot submit again and new choices require rationale', () => {
  assert.equal(decisionRequest({ ...view, decision: { ...pending, mainSha: 'f'.repeat(40) } }, draft), undefined);
  assert.equal(decisionRequest({ ...view, decision: undefined }, { ...draft, rationale: ' ' }), undefined);
  assert.equal(decisionRequest({ ...view, decision: undefined }, { ...draft, rationale: '  New rationale.  ' }).rationale, 'New rationale.');
});
test('pending isolated tests block decision submission', () => {
  assert.equal(decisionRequest({ ...view, decision: undefined, candidates: [{ tests: { status: 'pending', provenance: 'isolated sandbox' } }] }, draft), undefined);
  assert.match(conflictMessage('tests_pending'), /still pending/);
});
test('a tests.done event for an old SHA cannot update board or compare tests for a newer SHA', () => {
  const current = { ...view, candidates: [{ agent: 'alice', sourceSha: 'b'.repeat(40), tests: { status: 'pending' } }] };
  const event = { type: 'tests.done', task: 'parser-escapes', agent: 'alice', sourceSha: 'a'.repeat(40), tests: { status: 'pass' } };
  assert.equal(updateTask(current, event).candidates[0].tests.status, 'pending');
  assert.equal(updateBoard({ tasks: [{ ...current, slug: 'parser-escapes' }] }, event).tasks[0].candidates[0].tests.status, 'pending');
});
test('publication conflicts are not reported as changed candidate heads', () => {
  assert.match(conflictMessage('decision_in_progress'), /signed decision/);
  assert.match(conflictMessage('task_decided'), /already published/);
  assert.match(conflictMessage('publication_pending'), /finish publishing first/);
  assert.equal(conflictMessage('stale'), 'Candidates changed, review again');
});
const temp = await mkdtemp(join(tmpdir(), 'heddle-decision-render-'));
after(() => rm(temp, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL('../src/decision-notice.tsx', import.meta.url))], outfile: join(temp, 'notice.mjs'), bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
const { DecisionNotice } = await import(pathToFileURL(join(temp, 'notice.mjs')));
test('pending publication renders immutable context without landed text or Why link', () => {
  const html = renderToString(DecisionNotice({ project: 'demo', decision: pending }));
  assert.match(html, /Decision recorded\. Publication pending\./);
  assert.match(html, /Recorded choice: bob/);
  assert.match(html, /decided by luke/);
  assert.match(html, /Keep exact signed rationale/);
  assert.doesNotMatch(html, /Landed|href=.*why/);
});
test('published decision renders the exact commit Why link', () => {
  const html = renderToString(DecisionNotice({ project: 'demo', decision: { ...pending, mainSha: 'f'.repeat(40) } }));
  assert.match(html, /Landed bob on main/);
  assert.ok(html.includes(`/p/demo/why/${'f'.repeat(40)}`));
  assert.doesNotMatch(html, /Publication pending/);
});
