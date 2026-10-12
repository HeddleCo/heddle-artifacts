// SPDX-License-Identifier: Apache-2.0
import type { FeedEvent } from '../../contracts/types';
import type { ProjectView, TaskView } from './api';
export function updateBoard(view: ProjectView, event: FeedEvent): ProjectView {
  return { ...view, tasks: view.tasks.map(task => {
    const slug = event.type === 'candidate.ready' ? event.candidate.task : event.type === 'decision.landed' ? event.decision.task : 'task' in event ? event.task : undefined;
    if (task.slug !== slug) return task;
    if (event.type === 'push.received') return { ...task, lanes: task.lanes.map(lane => lane.agent === event.agent ? { ...lane, lastSeenSha: event.sha } : lane) };
    if (event.type === 'candidate.ready') return { ...task, candidates: [...task.candidates.filter(c => c.agent !== event.candidate.agent), event.candidate] };
    if (event.type === 'tests.done') return { ...task, candidates: task.candidates.map(c => c.agent === event.agent && (!event.sourceSha || c.sourceSha === event.sourceSha) ? { ...c, tests: event.tests } : c) };
    if (event.type === 'decision.landed') return { ...task, decision: event.decision, status: 'landed', lanes: task.lanes.map(lane => ({ ...lane, status: lane.agent === event.decision.pick ? 'released' : 'abandoned' })) };
    return task;
  }) };
}
export function updateTask(view: TaskView, event: FeedEvent): TaskView {
  if (event.type === 'candidate.ready' && event.candidate.task === view.task.slug) return { ...view, candidates: [...view.candidates.filter(c => c.agent !== event.candidate.agent), event.candidate] };
  if (event.type === 'tests.done' && event.task === view.task.slug) return { ...view, candidates: view.candidates.map(c => c.agent === event.agent && (!event.sourceSha || c.sourceSha === event.sourceSha) ? { ...c, tests: event.tests } : c) };
  if ((event.type === 'review.posted' || event.type === 'discussion.posted') && event.turn.task === view.task.slug) return { ...view, turns: [...view.turns.filter(t => t.id !== event.turn.id), event.turn], ...(event.type === 'review.posted' ? { review: event.review } : {}) };
  if (event.type === 'decision.landed' && event.decision.task === view.task.slug) return { ...view, decision: event.decision };
  return view;
}
