// SPDX-License-Identifier: Apache-2.0
// The combined check on the board and compare page, and its gate on the land button.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import renderToString from 'preact-render-to-string';
import { h } from 'preact';
import { aloneText, combinedText, combinedBlock, decisionRequest, conflictMessage } from '../src/decision.ts';

const verdict = { status: 'ready', freshness: 'current', mergeType: 'fast-forward', conflictCount: 0, impact: 'none', impactCategories: [], blockers: [] };
const tests = (status, passed, failed, extra = {}) => ({ status, passed, failed, summary: `Isolated sandbox: ${passed} passed, ${failed} failed`, durationMs: 4100, provenance: 'isolated sandbox', ...extra });
const candidate = (combined, own = tests('pass', 22, 0)) => ({ task: 'table-shape', agent: 'finn', state: 'hs-finn', sourceSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), parentSha: 'd'.repeat(40), subject: 'Return the header', diffstat: { files: 2, insertions: 9, deletions: 0 }, tests: own, conflicts: [], signedBy: 'f'.repeat(64), capturedAt: '2026-10-13T00:00:00Z', ...(combined ? { combined } : {}) });
const base = { mainSha: 'a'.repeat(40), mainState: 'hs-main', candidateSha: 'b'.repeat(40), heddle: verdict, conflicts: [], state: 'hs-merged', sha: 'e'.repeat(40), treeSha: '9'.repeat(40) };
const failing = { ...base, status: 'fail', tests: tests('fail', 19, 3, { failures: ['readTable > returns the header', 'readTable > returns the body rows', 'readTable > handles a header-only table'], excerpt: "AssertionError: expected [ ' Name ', ' Age ' ] to deeply equal [ 'Name', 'Age' ]", observation: { publicKey: 'k', payload: 'p', signature: 's' } }) };
const conflict = { ...base, status: 'conflict', sha: undefined, treeSha: undefined, state: undefined, heddle: { ...verdict, status: 'blocked', conflictCount: 1, blockers: ['1 path conflict(s) need manual resolution after refresh'] }, conflicts: [{ path: 'src/table.ts', symbol: 'parseRow', lines: [3, 8] }] };

test('the board line puts the alone result next to the combined result', () => {
  assert.equal(aloneText(candidate(failing)), '✓ 22/22 alone');
  assert.deepEqual(combinedText(candidate(failing)), { tone: 'fail', text: '✕ 3 failing combined with main' });
  assert.deepEqual(combinedText(candidate({ ...base, status: 'pass', tests: tests('pass', 22, 0) })), { tone: 'pass', text: '✓ 22/22 combined with main' });
  assert.deepEqual(combinedText(candidate({ ...base, status: 'pending', tests: tests('pending', 0, 0) })), { tone: 'pending', text: '○ testing combined with main' });
  assert.deepEqual(combinedText(candidate(conflict)), { tone: 'conflict', text: '⚑ conflicts with main: src/table.ts (parseRow)' });
  assert.equal(combinedText(candidate(undefined)), undefined, 'a current candidate shows no combined line');
});
test('a pick behind main cannot be submitted until its combined result passes', () => {
  const view = combined => ({ task: { slug: 'table-shape' }, candidates: [candidate(combined)], turns: [], heads: ['hs-finn'] });
  const draft = { pick: 'finn', decider: 'luke', rationale: 'Ship it' };
  for (const blocked of [failing, conflict, { ...base, status: 'pending', tests: tests('pending', 0, 0) }, { ...base, status: 'error', tests: tests('error', 0, 0) }]) {
    assert.equal(decisionRequest(view(blocked), draft), undefined, blocked.status);
    assert.ok(combinedBlock(candidate(blocked)));
  }
  assert.match(combinedBlock(candidate(failing)), /passes alone, but 3 tests fail combined with main/);
  assert.match(combinedBlock(candidate(conflict)), /conflicts with main in src\/table\.ts \(parseRow\)/);
  assert.deepEqual(decisionRequest(view({ ...base, status: 'pass', tests: tests('pass', 22, 0) }), draft), { ...draft, expectHeads: ['hs-finn'] });
  assert.deepEqual(decisionRequest(view(undefined), draft), { ...draft, expectHeads: ['hs-finn'] });
  for (const code of ['combined_pending', 'combined_failing', 'combined_conflict', 'combined_untested']) assert.notEqual(conflictMessage(code), conflictMessage('unknown'), code);
});

const temp = await mkdtemp(join(tmpdir(), 'heddle-combined-render-'));
after(() => rm(temp, { recursive: true, force: true }));
for (const [name, file] of [['combined', '../src/combined.tsx'], ['notice', '../src/decision-notice.tsx']])
  await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], outfile: join(temp, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
const { CombinedLine, CombinedPanel } = await import(pathToFileURL(join(temp, 'combined.mjs')));
const { DecisionNotice } = await import(pathToFileURL(join(temp, 'notice.mjs')));
const text = html => html.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('compare panel shows Heddle\'s clean merge, the failing test names and the output', () => {
  const html = renderToString(h(CombinedPanel, { candidate: candidate(failing) }));
  assert.match(text(html), /✓ 22\/22 alone · ✕ 3 failing combined with main/);
  assert.match(text(html), /Heddle merged it with main cleanly \(fast-forward, 0 conflicts\) as eeeeeeeeee/);
  for (const name of failing.tests.failures) assert.ok(text(html).includes(name), name);
  assert.match(text(html), /expected \[ ' Name ', ' Age ' \]/);
  assert.match(text(html), /signed observation/);
  assert.match(text(renderToString(h(CombinedLine, { candidate: candidate(failing) }))), /^✓ 22\/22 alone · ✕ 3 failing combined with main$/);
});
test('compare panel reports a conflict in Heddle\'s terms, and nothing for a current candidate', () => {
  const html = text(renderToString(h(CombinedPanel, { candidate: candidate(conflict) })));
  assert.match(html, /Heddle could not merge this candidate with main: 1 conflict\./);
  assert.match(html, /src\/table\.ts · parseRow · lines 3–8/);
  assert.equal(renderToString(h(CombinedPanel, { candidate: candidate(undefined) })), '');
  assert.equal(renderToString(h(CombinedLine, { candidate: candidate(undefined) })), '');
});
test('a decision that landed Heddle\'s merge says so', () => {
  const decision = { task: 'table-shape', pick: 'finn', decider: 'luke', rationale: 'Merged result passes', alternatives: [], resolutionState: 'r', landState: 'l', mainSha: '1'.repeat(40), at: '2026-10-13T00:00:00Z',
    combined: { sha: 'e'.repeat(40), treeSha: '9'.repeat(40), mainSha: 'a'.repeat(40), state: 'hs-merged' } };
  assert.match(text(renderToString(h(DecisionNotice, { project: 'demo', decision }))), /Landed as Heddle's merge with main aaaaaaaaaa, tested as eeeeeeeeee\./);
});
