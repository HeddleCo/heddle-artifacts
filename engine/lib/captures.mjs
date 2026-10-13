// SPDX-License-Identifier: Apache-2.0
import { heddle, save } from './state.mjs';
import { slug, Rejection } from './process.mjs';

// One uncached pair per read keeps a history request from monopolizing the writer queue.
// The child process and its output are bounded even for pathological repositories.
export const SEMANTIC_TIMEOUT_MS = 2000;
export async function captures(state, request) {
  slug(request.task);
  const task = state.tasks[request.task];
  if (!task) throw new Rejection('unknown_task', 'Task is not registered');
  state.semanticDiffs ??= Object.create(null);
  let computed = 0, pending = 0;
  const lanes = [];
  for (const lane of Object.values(state.lanes).filter(l => l.task === request.task && state.agents[l.agent]?.kind !== 'reviewer').sort((a, b) => a.agent.localeCompare(b.agent))) {
    let from = task.baseState;
    const history = [];
    for (const candidate of Object.values(lane.seen || {}).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || a.sourceSha.localeCompare(b.sourceSha))) {
      const key = JSON.stringify([from, candidate.state]);
      let semantic = state.semanticDiffs[key];
      if (!semantic && computed < 1) {
        computed++;
        try {
          const result = await heddle(['diff', from, candidate.state, '--semantic'], undefined, undefined, { timeout: SEMANTIC_TIMEOUT_MS, maxBytes: 8 * 1024 * 1024 });
          if (result.output_kind !== 'diff' || !Array.isArray(result.semantic_changes)) throw new Error('semantic_unavailable');
          semantic = { status: 'ready', changes: result.semantic_changes.map(change => {
            if (typeof change.change_type !== 'string' || typeof change.description !== 'string') throw new Error('semantic_unavailable');
            // Preserve Heddle's own descriptions and names, without retaining the patch.
            return Object.fromEntries(['change_type', 'description', 'path', 'from_path', 'to_path', 'old_name', 'new_name', 'importance'].filter(k => typeof change[k] === 'string').map(k => [k, change[k]]));
          }) };
        } catch { semantic = { status: 'unavailable' }; }
        state.semanticDiffs[key] = semantic;
      }
      if (!semantic) { semantic = { status: 'pending' }; pending++; }
      history.push({ ...candidate, fromState: from, semantic });
      from = candidate.state;
    }
    lanes.push({ agent: lane.agent, captures: history });
  }
  if (computed) await save(state);
  return { task: request.task, lanes, pending, cacheChanged: computed > 0 };
}
