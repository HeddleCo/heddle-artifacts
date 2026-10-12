// SPDX-License-Identifier: Apache-2.0
// Contract fixture only. This is NOT Heddle and must never be used for production evidence.
import { isolatedTestResult } from '../engine/lib/isolated-tests.mjs';
export const sha = value => Array.from(new TextEncoder().encode(value)).reduce((a, b) => ((a * 31 + b) >>> 0), 0).toString(16).padStart(40, '0');
export function emptyState() { return { agents: {}, tasks: {}, candidates: {}, turns: [], decisions: {}, ops: {}, mainSha: sha('seed'), generation: 0 }; }
export function executeFixture(state, command, input) {
  if (input.opId && state.ops[input.opId]) return state.ops[input.opId];
  let result;
  if (command === 'init') result = { mainState: sha('main'), mainSha: state.mainSha };
  else if (command === 'task.create') { result = { thread: `task/${input.task}`, baseState: sha('base'), baseSha: state.mainSha }; state.tasks[input.task] = { ...result, intent: input.intent }; }
  else if (command === 'agent.enroll') { result = { publicKey: (sha(input.agent.id) + sha('key')).slice(0, 64) }; state.agents[input.agent.id] = { ...input.agent, ...result }; }
  else if (command === 'lane.open') result = { laneThread: `task/${input.task}/${input.agent}`, leaseId: sha(input.agent) };
  else if (command === 'ingest') {
    const results = [];
    for (const item of input.items) {
      const key = `${item.task}/${item.agent}`, previous = state.candidates[key];
      if (previous?.sourceSha === item.sha) { results.push({ agent: item.agent, task: item.task, status: 'duplicate', candidate: previous }); continue; }
      const candidate = { task: item.task, agent: item.agent, state: sha(item.sha + item.agent), sourceSha: item.sha, treeSha: sha('tree' + item.sha), parentSha: state.tasks[item.task].baseSha, subject: `Change by ${item.agent}`, diffstat: { files: 1, insertions: 1, deletions: 1 }, tests: { status: 'pass', passed: 14, failed: 0, summary: 'fixture tests', durationMs: 5 }, conflicts: [], signedBy: state.agents[item.agent].publicKey, capturedAt: '2026-10-10T12:00:00.000Z' };
      if (state.isolateUnreviewed && input.isolateUnreviewed) candidate.tests = { status: 'pending', passed: 0, failed: 0, summary: 'Isolated sandbox tests pending', durationMs: 0, provenance: 'isolated sandbox', sourceSha: item.sha };
      state.candidates[key] = candidate; results.push({ agent: item.agent, task: item.task, status: 'captured', candidate });
    }
    const conflicts = {};
    for (const candidate of Object.values(state.candidates)) {
      const others = Object.values(state.candidates).filter(c => c.task === candidate.task && c.agent !== candidate.agent);
      candidate.conflicts = others.length ? [{ path: 'src/table.ts', region: 'parseRow', with: others.map(c => c.agent) }] : [];
      conflicts[candidate.task] = candidate.conflicts;
    }
    result = { results, conflicts };
  }
  else if (command === 'tests.record') {
    const candidate = state.candidates[`${input.task}/${input.agent}`];
    if (!candidate || candidate.sourceSha !== input.sourceSha || candidate.tests?.status !== 'pending' || state.decisions[input.task]) result = { ignored: true };
    else if (input.run.sourceSha !== candidate.sourceSha || input.run.treeSha !== candidate.treeSha) return { error: { code: 'test_binding_mismatch', message: 'SHA mismatch' } };
    else { candidate.tests = isolatedTestResult(input.run); result = { ignored: false, candidate }; }
  }
  else if (command === 'candidates') { const candidates = Object.values(state.candidates).filter(c => c.task === input.task); result = { heads: candidates.map(c => c.state).sort(), candidates }; }
  else if (command === 'diff') result = { diff: `diff --git a/src/table.ts b/src/table.ts\n+${input.agent}\n` };
  else if (command === 'discuss') { const agent = state.agents[input.author]; result = { id: sha(input.opId), task: input.task, author: input.author, kind: agent.kind, body: input.body, ...(input.replyTo ? { replyTo: input.replyTo } : {}), heddleDiscussion: sha(input.task), signedBy: agent.publicKey, at: '2026-10-10T12:00:00.000Z' }; state.turns.push(result); }
  else if (command === 'decide') {
    const heads = Object.values(state.candidates).filter(c => c.task === input.task).map(c => c.state).sort();
    if (JSON.stringify([...input.expectHeads].sort()) !== JSON.stringify(heads)) return { error: { code: 'stale', message: 'Candidates changed' } };
    if (Object.values(state.candidates).some(c => c.task === input.task && c.tests?.status === 'pending')) return { error: { code: 'tests_pending', message: 'Tests pending' } };
    result = { task: input.task, decider: input.decider, pick: input.pick, rationale: input.rationale, alternatives: Object.values(state.candidates).filter(c => c.task === input.task && c.agent !== input.pick).map(c => c.agent), resolutionState: sha(input.opId + 'resolve'), landState: sha(input.opId + 'land'), mainSha: sha(sha(input.opId + 'land')), at: '2026-10-10T12:00:00.000Z' }; state.decisions[input.task] = result;
  }
  else if (command === 'publish') { const decision = Object.values(state.decisions).at(-1); state.mainSha = sha(decision?.landState ?? 'seed'); if (decision) decision.mainSha = state.mainSha; result = { main: state.mainSha, pushed: ['main', 'refs/notes/heddle', 'refs/notes/heddle-why'], verify: { exportRoundTrip: true, treeMatch: true, fsck: true } }; }
  else if (command === 'why') { const decision = Object.values(state.decisions).find(d => d.mainSha === input.sha); result = { narrative: decision ? `Heddle decision · task ${decision.task}\nChosen: ${decision.pick}\nRejected: ${decision.alternatives.join(', ')}\n${decision.rationale}` : 'Fixture candidate' }; }
  else if (command === 'selftest') result = { heddleVersion: 'stub', gitVersion: 'fixture', ok: true };
  else throw new Error('Unknown fixture command');
  if (input.opId) { state.ops[input.opId] = result; state.generation++; }
  return structuredClone(result);
}
