// SPDX-License-Identifier: Apache-2.0
import type { Candidate, Decision } from '../../contracts/types';
import type { TaskView } from './api';
export function isPublished(decision?: Decision): boolean {
  return !!decision && /^[a-f0-9]{40}$/i.test(decision.mainSha);
}
export function decisionRequest(view: TaskView, draft: { pick: string; decider: string; rationale: string; anchor?: string; tags?: string[] }) {
  if (isPublished(view.decision)) return;
  if (view.candidates.some(c => c.tests?.status === 'pending')) return;
  // A recorded signature cannot be rewritten by draft fields or whitespace normalization.
  const choice = view.decision ?? { ...draft, rationale: draft.rationale.trim() };
  if (!choice.pick || !choice.decider || !choice.rationale.trim()) return;
  // A pick behind main lands only once its result combined with main passed.
  if (!view.decision && combinedBlock(view.candidates.find(c => c.agent === choice.pick))) return;
  return { pick: choice.pick, decider: choice.decider, rationale: choice.rationale, ...(choice.anchor ? { anchor: choice.anchor } : {}), ...(choice.tags !== undefined ? { tags: [...choice.tags] } : {}), expectHeads: [...view.heads] };
}
export function conflictMessage(code?: string): string {
  if (code === 'tests_pending') return 'Isolated candidate tests are still pending. Refresh when they finish.';
  if (code === 'decision_in_progress') return 'A signed decision is already recorded. Refresh to retry its publication.';
  if (code === 'task_decided') return 'This task is already published. Refresh to see the decision.';
  if (code === 'publication_pending') return 'A recorded decision must finish publishing first. Refresh to check progress.';
  if (code === 'stale') return 'Candidates changed, review again';
  if (code === 'combined_pending') return 'This candidate is still being tested combined with main. Refresh when it finishes.';
  if (code === 'combined_failing') return 'This candidate fails its tests combined with main. The agent must fix it before it can land.';
  if (code === 'combined_conflict') return 'This candidate conflicts with main. The agent must resolve it before it can land.';
  if (code === 'combined_untested') return 'This candidate was not tested combined with main.';
  return 'Task state changed. Refresh before retrying.';
}

// The combined check: a candidate behind main, merged with main by Heddle, and that result's tests.
const where = (c: { path: string; symbol?: string }) => c.symbol ? `${c.path} (${c.symbol})` : c.path;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** The candidate's own tests in a few words, for the "alone" half of the board line. */
export function aloneText(c: Candidate): string {
  const t = c.tests;
  if (!t || t.status === 'pending') return '○ tests pending alone';
  if (t.status === 'pass') return `✓ ${t.passed}/${t.passed + t.failed} alone`;
  if (t.status === 'fail') return `✕ ${plural(t.failed, 'failing test')} alone`;
  return t.status === 'skipped' ? '○ not tested alone' : '✕ tests could not run alone';
}

/** One line for the combined result, or undefined when the candidate is current or contains main. */
export function combinedText(c: Candidate): { tone: 'pass' | 'fail' | 'pending' | 'conflict'; text: string } | undefined {
  const combined = c.combined;
  if (!combined) return;
  if (combined.status === 'conflict') return { tone: 'conflict', text: `⚑ conflicts with main: ${combined.conflicts.map(where).join(', ')}` };
  const t = combined.tests;
  if (combined.status === 'pending' || !t || t.status === 'pending') return { tone: 'pending', text: '○ testing combined with main' };
  if (combined.status === 'pass') return { tone: 'pass', text: `✓ ${t.passed}/${t.passed + t.failed} combined with main` };
  if (combined.status === 'fail') return { tone: 'fail', text: `✕ ${t.failed} failing combined with main` };
  if (combined.status === 'skipped') return { tone: 'pending', text: '○ combined with main: not tested' };
  return { tone: 'fail', text: '✕ combined tests could not run' };
}

/** Why this candidate cannot land yet, or undefined. The server applies the same rule. */
export function combinedBlock(c: Candidate | undefined): string | undefined {
  const combined = c?.combined;
  if (!c || !combined) return;
  if (combined.status === 'pass') return;
  if (combined.status === 'conflict') return `${c.agent} conflicts with main in ${combined.conflicts.map(where).join(', ')}. The agent must resolve it and push again.`;
  if (combined.status === 'fail') return `${c.agent} passes alone, but ${plural(combined.tests?.failed ?? 0, 'test')} fail combined with main. The agent must fix them and push again.`;
  if (combined.status === 'pending') return `${c.agent} is being tested combined with main. Landing waits for the result.`;
  if (combined.status === 'skipped') return `${c.agent} was not tested combined with main.`;
  return `${c.agent}'s tests could not run combined with main.`;
}

