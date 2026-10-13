// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { combinedBrief, combinedLine, COMBINED_TASKS } from '../lib/harness.mjs';

const brief = await readFile(new URL('../briefs/finn.md', import.meta.url), 'utf8');
const main = 'a'.repeat(40), merged = 'e'.repeat(40);
const decision = { task: 'cell-whitespace', pick: 'erin', decider: 'luke', mainSha: main, rationale: 'Code tables need their indentation.\nCallers trim.' };
const verdict = { status: 'ready', freshness: 'current', mergeType: 'fast-forward', conflictCount: 0, impact: 'none', impactCategories: [], blockers: [] };
const failing = { mainSha: main, mainState: 'hs-main', candidateSha: 'b'.repeat(40), status: 'fail', heddle: verdict, conflicts: [], state: 'hs-merged', sha: merged, treeSha: '9'.repeat(40),
  tests: { status: 'fail', passed: 19, failed: 3, summary: 'Isolated sandbox: 19 passed, 3 failed', durationMs: 4100, failures: ['test/read-table.test.ts > readTable > returns the header'], excerpt: "FAIL  test/read-table.test.ts > readTable > returns the header\nAssertionError: expected [ ' Name ' ]\n```\nnot a fence" } };
const view = combined => ({ task: { slug: 'table-header' }, candidates: [{ agent: 'finn', sourceSha: 'b'.repeat(40), tests: { status: 'pass', passed: 22, failed: 0 }, conflicts: [], ...(combined ? { combined } : {}) }], turns: [], heads: [] });

test('the two storyline briefs never mention each other or the break', async () => {
  const erin = await readFile(new URL('../briefs/erin.md', import.meta.url), 'utf8');
  for (const [text, other] of [[erin, 'finn'], [brief, 'erin']]) {
    assert.doesNotMatch(text, new RegExp(other, 'i'));
    assert.doesNotMatch(text, /combined|another task|other task|main advance/i);
  }
  assert.deepEqual(COMBINED_TASKS.map(t => t.agent), ['erin', 'finn']);
});
test('the resolution brief carries the landed decision, the failing tests and the merged commit, quoted', () => {
  const text = combinedBrief('finn', brief, view(failing), decision);
  assert.ok(text.startsWith(brief.trimEnd()));
  assert.ok(text.includes(`Main is now \`${main}\`. luke chose erin's work for task cell-whitespace.`));
  assert.ok(text.includes('> Code tables need their indentation.\n> Callers trim.'));
  assert.ok(text.includes('Heddle merged your candidate with main cleanly (fast-forward, 0 conflicts)'));
  assert.ok(text.includes('19 passed, 3 failed'));
  assert.ok(text.includes('- test/read-table.test.ts > readTable > returns the header'));
  // Sandbox output is untrusted text: every line is a quotation, so it cannot open a fence or a heading.
  assert.ok(text.includes("> AssertionError: expected [ ' Name ' ]\n> ```\n> not a fence"));
  assert.ok(text.includes(`git fetch upstream refs/heads/combined/table-header/finn/${merged}\n    git merge --ff-only FETCH_HEAD`));
  assert.match(text, /Begin it with "Combined:"/);
  assert.doesNotMatch(text, /git merge upstream\/main/);
});
test('a conflict brief names Heddle\'s conflicts and asks for a merge of main instead', () => {
  const conflict = { ...failing, status: 'conflict', sha: undefined, treeSha: undefined, tests: undefined, heddle: { ...verdict, status: 'blocked', conflictCount: 1 }, conflicts: [{ path: 'src/table.ts', symbol: 'parseRow', lines: [3, 8] }] };
  const text = combinedBrief('finn', brief, view(conflict), decision);
  assert.ok(text.includes('- `src/table.ts` in `parseRow`, lines 3–8'));
  assert.ok(text.includes('git fetch upstream main\n    git merge upstream/main'));
});
test('the brief is refused when there is nothing combined to respond to', () => {
  assert.throws(() => combinedBrief('finn', brief, view(undefined), decision), /no combined check/);
  assert.throws(() => combinedBrief('finn', brief, view({ ...failing, status: 'pass' }), decision), /does not fail/);
  assert.throws(() => combinedBrief('finn', brief, view(failing), { ...decision, mainSha: 'c'.repeat(40) }), /not against the landed decision/);
});
test('the console line matches the board', () => {
  assert.equal(combinedLine(view(failing).candidates[0]), '✓ 22/22 alone · ✕ 3 failing combined with main');
  assert.equal(combinedLine(view(undefined).candidates[0]), '✓ 22/22 alone');
});
