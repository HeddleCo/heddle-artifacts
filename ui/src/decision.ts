// SPDX-License-Identifier: Apache-2.0
import type { Decision } from '../../contracts/types';
import type { TaskView } from './api';
export function isPublished(decision?: Decision): boolean {
  return !!decision && /^[a-f0-9]{40}$/i.test(decision.mainSha);
}
export function decisionRequest(view: TaskView, draft: { pick: string; decider: string; rationale: string }) {
  if (isPublished(view.decision)) return;
  if (view.candidates.some(c => c.tests?.status === 'pending')) return;
  // A recorded signature cannot be rewritten by draft fields or whitespace normalization.
  const choice = view.decision ?? { ...draft, rationale: draft.rationale.trim() };
  if (!choice.pick || !choice.decider || !choice.rationale.trim()) return;
  return { pick: choice.pick, decider: choice.decider, rationale: choice.rationale, expectHeads: [...view.heads] };
}
export function conflictMessage(code?: string): string {
  if (code === 'tests_pending') return 'Isolated candidate tests are still pending. Refresh when they finish.';
  if (code === 'decision_in_progress') return 'A signed decision is already recorded. Refresh to retry its publication.';
  if (code === 'task_decided') return 'This task is already published. Refresh to see the decision.';
  if (code === 'publication_pending') return 'A recorded decision must finish publishing first. Refresh to check progress.';
  if (code === 'stale') return 'Candidates changed, review again';
  return 'Task state changed. Refresh before retrying.';
}
