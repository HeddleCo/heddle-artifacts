// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewCurrent, reviewable, revisionBrief } from '../lib/harness.mjs';

const brief = '# alice: parser-escapes\n\nSupport escaped pipes.\n';
const review = {
  summary: 'Both handle \\| but only bob keeps paired backslashes literal.',
  perCandidate: [
    { agent: 'alice', verdict: 'concerns', notes: 'No test for a backslash pair before a pipe (\\\\|).\nThe regex splits it.' },
    { agent: 'bob', verdict: 'approve', notes: 'Scanner covers parity.' },
  ],
  recommendation: { pick: 'bob', why: 'Parity is tested.' }, model: '@cf/zai-org/glm-5.2',
};
const turn = (id, author, kind, body) => ({ id, task: 'parser-escapes', author, kind, body, heddleDiscussion: 'd', signedBy: 'k', at: '2026-10-13T00:00:00Z' });
const view = (overrides = {}) => ({
  task: { slug: 'parser-escapes' },
  candidates: [{ agent: 'alice', conflicts: [], tests: { status: 'pass' } }, { agent: 'bob', conflicts: [], tests: { status: 'pass' } }],
  heads: ['s1', 's2'], review, reviewAttempt: { status: 'completed', heads: ['s1', 's2'], review },
  turns: [
    turn('t1', 'alice', 'agent', 'ALICE-OWN-NOTE: regex split.'),
    turn('t2', 'bob', 'agent', 'I used a scanner.\n```\nodd backslashes escape\n```'),
    turn('t3', 'reviewer', 'reviewer', JSON.stringify(review)),
    turn('t4', 'luke', 'human', 'HUMAN-TURN'),
  ],
  ...overrides,
});

test('a revision brief carries the original brief, the review and verbatim peer notes', () => {
  const text = revisionBrief('alice', brief, view());
  assert.ok(text.startsWith(brief.trimEnd()));
  assert.match(text, /AI reviewer \(@cf\/zai-org\/glm-5\.2\)/);
  assert.ok(text.includes('> Both handle \\| but only bob keeps paired backslashes literal.'));
  assert.ok(text.includes('your candidate (alice): concerns\n\n> No test for a backslash pair before a pipe (\\\\|).\n> The regex splits it.'));
  assert.ok(text.includes('### Reviewer recommendation: bob\n\n> Parity is tested.'));
  // The peer's note is quoted line by line, unchanged, including its code fence.
  assert.ok(text.includes('#### bob\n\n> I used a scanner.\n> ```\n> odd backslashes escape\n> ```'));
  assert.match(text, /Begin it with "Revision:"/);
  assert.match(text, /- Revise: /); assert.match(text, /- Keep: .*push nothing/);
});

test('a revision brief excludes the agent\'s own note, other agents\' verdicts, reviewer and human turns', () => {
  const text = revisionBrief('alice', brief, view());
  assert.ok(!text.includes('ALICE-OWN-NOTE'));
  assert.ok(!text.includes('Scanner covers parity.'));
  assert.ok(!text.includes('HUMAN-TURN'));
  assert.ok(!text.includes('"perCandidate"'));
  const bob = revisionBrief('bob', brief, view());
  assert.ok(bob.includes('> ALICE-OWN-NOTE: regex split.')); assert.ok(!bob.includes('I used a scanner.'));
  assert.ok(bob.includes('your candidate (bob): approve\n\n> Scanner covers parity.'));
});

test('a revision brief without peers says so, and omits a missing recommendation', () => {
  const solo = { ...review, perCandidate: [{ agent: 'carol', verdict: 'approve', notes: 'Clear.' }], recommendation: undefined };
  const text = revisionBrief('carol', brief, view({ review: solo, turns: [turn('t1', 'carol', 'agent', 'CAROL-NOTE')] }));
  assert.match(text, /No other agent has posted a note on this task\./);
  assert.ok(!text.includes('Reviewer recommendation')); assert.ok(!text.includes('CAROL-NOTE'));
});

test('a revision brief refuses the fallback review, a missing review and an uncovered agent', () => {
  assert.throws(() => revisionBrief('alice', brief, view({ review: { ...review, model: 'fallback' } })), /fallback review/);
  assert.throws(() => revisionBrief('alice', brief, view({ review: undefined })), /No review/);
  assert.throws(() => revisionBrief('carol', brief, view()), /does not cover carol/);
});

test('the round waits for the completed review of the current heads covering every candidate', () => {
  assert.equal(reviewCurrent(view()), true);
  assert.equal(reviewCurrent(view({ heads: ['s1', 's3'] })), false, 'heads moved since the review');
  assert.equal(reviewCurrent(view({ reviewAttempt: { status: 'reserved', heads: ['s1', 's2'] } })), false, 'review in flight');
  assert.equal(reviewCurrent(view({ reviewAttempt: { status: 'completed', heads: ['s1', 's2'], review: { ...review, model: 'fallback' } } })), true, 'operator retry replaced the fallback');
  assert.equal(reviewCurrent(view({ review: { ...review, perCandidate: review.perCandidate.slice(0, 1) } })), false, 'bob not covered');
  assert.equal(reviewCurrent(view({ review: undefined })), false);
  assert.equal(reviewable([{ conflicts: [{}], tests: { status: 'fail' } }]), false);
  assert.equal(reviewable([{ conflicts: [], tests: { status: 'pass' } }]), true);
});
