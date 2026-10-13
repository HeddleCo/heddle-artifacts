// SPDX-License-Identifier: Apache-2.0
import { heddle, save } from './state.mjs';
import { slug, Rejection } from './process.mjs';

// One uncached pair per read keeps a history request from monopolizing the writer queue.
// The child process and its output are bounded even for pathological repositories.
export const SEMANTIC_TIMEOUT_MS = 10000;
// A timeout says the box was slow, not that the pair has no summary: it stays pending for a later
// read and becomes unavailable only after this many timed-out attempts.
export const SEMANTIC_TIMEOUT_ATTEMPTS = 3;
// Tests shorten the deadline through the operator process environment; requests never set it.
function semanticTimeoutMs() {
  const ms = Number(process.env.ENGINE_SEMANTIC_TIMEOUT_MS);
  return Number.isInteger(ms) && ms > 0 ? ms : SEMANTIC_TIMEOUT_MS;
}
// Returns the cache entry for one pair: ready, unavailable, or pending with its timed-out attempts so far.
async function semanticDiff(from, to, timeouts) {
  try {
    const result = await heddle(['diff', from, to, '--semantic'], undefined, undefined, { timeout: semanticTimeoutMs(), maxBytes: 8 * 1024 * 1024 });
    if (result.output_kind !== 'diff' || !Array.isArray(result.semantic_changes)) throw new Error('semantic_unavailable');
    return { status: 'ready', changes: result.semantic_changes.map(change => {
      if (typeof change.change_type !== 'string' || typeof change.description !== 'string') throw new Error('semantic_unavailable');
      // Preserve Heddle's own descriptions and names, without retaining the patch.
      return Object.fromEntries(['change_type', 'description', 'path', 'from_path', 'to_path', 'old_name', 'new_name', 'importance'].filter(k => typeof change[k] === 'string').map(k => [k, change[k]]));
    }) };
  } catch (error) {
    if (error?.timedOut && timeouts + 1 < SEMANTIC_TIMEOUT_ATTEMPTS) return { status: 'pending', timeouts: timeouts + 1 };
    // Heddle answered with an error or an unexpected shape, or timed out on its last attempt.
    return { status: 'unavailable' };
  }
}
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
      const cached = state.semanticDiffs[key];
      // Only ready and unavailable are final; a pending entry only carries its timed-out attempts.
      let semantic = cached?.status === 'pending' ? undefined : cached;
      if (!semantic && computed < 1) {
        computed++;
        const entry = await semanticDiff(from, candidate.state, cached?.timeouts ?? 0);
        state.semanticDiffs[key] = entry;
        if (entry.status !== 'pending') semantic = entry;
      }
      if (!semantic) { semantic = { status: 'pending' }; pending++; }
      history.push({ ...candidate, fromState: from, semantic });
      from = candidate.state;
    }
    lanes.push({ agent: lane.agent, captures: history });
  }
  // A timed-out attempt changes the cache too: its count must survive to the next read and a restore.
  if (computed) await save(state);
  return { task: request.task, lanes, pending, cacheChanged: computed > 0 };
}
