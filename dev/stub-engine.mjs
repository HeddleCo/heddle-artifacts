// SPDX-License-Identifier: Apache-2.0
// Contract fixture only. This is NOT Heddle and must never be used for production evidence.
import { isolatedTestResult } from '../engine/lib/isolated-tests.mjs';
import { combinedRefusal } from '../engine/lib/combined-rule.mjs';
const cleanVerdict = { status: 'ready', freshness: 'current', mergeType: 'fast-forward', conflictCount: 0, impact: 'none', impactCategories: [], blockers: [] };
/**
 * Fixture of the engine's combined check. A candidate behind main is "merged" with it; fixture hooks
 * decide which candidates already contain main (state.containsMain) or conflict (state.conflictsWithMain).
 */
function refreshCombined(state, task, isolate) {
  if (state.decisions[task]) return;
  for (const candidate of Object.values(state.candidates).filter(c => c.task === task)) {
    if (state.tasks[task].baseSha === state.mainSha || state.containsMain?.includes(candidate.sourceSha)) { delete candidate.combined; continue; }
    if (candidate.combined?.mainSha === state.mainSha && candidate.combined.candidateSha === candidate.sourceSha) continue;
    const base = { mainSha: state.mainSha, mainState: sha('state' + state.mainSha), candidateSha: candidate.sourceSha };
    if (state.conflictsWithMain?.includes(candidate.agent)) { candidate.combined = { ...base, status: 'conflict', heddle: { ...cleanVerdict, status: 'blocked', freshness: 'stale', mergeType: 'path conflicts', conflictCount: 1, blockers: ['1 path conflict(s) need manual resolution after refresh'] }, conflicts: [{ path: 'src/table.ts', symbol: 'parseRow', lines: [3, 8] }] }; continue; }
    const combinedSha = sha('combined' + candidate.sourceSha + state.mainSha);
    candidate.combined = { ...base, status: isolate ? 'pending' : 'skipped', heddle: cleanVerdict, conflicts: [], state: sha('merged' + combinedSha), sha: combinedSha, treeSha: sha('tree' + combinedSha),
      tests: isolate ? { status: 'pending', passed: 0, failed: 0, summary: 'Combined tests pending in the isolated sandbox', durationMs: 0, provenance: 'isolated sandbox', sourceSha: combinedSha }
        : { status: 'skipped', passed: 0, failed: 0, summary: 'Combined tests run only in the isolated sandbox', durationMs: 0 } };
  }
}
export const sha = value => Array.from(new TextEncoder().encode(value)).reduce((a, b) => ((a * 31 + b) >>> 0), 0).toString(16).padStart(40, '0');
export function emptyState() { return { agents: {}, tasks: {}, lanes: {}, semanticDiffs: {}, candidates: {}, turns: [], decisions: {}, ops: {}, mainSha: sha('seed'), generation: 0 }; }
export function executeFixture(state, command, input) {
  if (input.opId && state.ops[input.opId]) return state.ops[input.opId];
  let result;
  if (command === 'init') result = { mainState: sha('main'), mainSha: state.mainSha };
  else if (command === 'task.create') { result = { thread: `task/${input.task}`, baseState: sha('base'), baseSha: state.mainSha }; state.tasks[input.task] = { ...result, intent: input.intent }; }
  else if (command === 'agent.enroll') { result = { publicKey: (sha(input.agent.id) + sha('key')).slice(0, 64) }; state.agents[input.agent.id] = { ...input.agent, ...result }; }
  else if (command === 'lane.open') { result = { laneThread: `task/${input.task}/${input.agent}`, leaseId: sha(input.agent),
    // Mirror the engine: agent lanes are briefed with earlier decisions' rationale.
    ...(state.agents?.[input.agent]?.kind === 'reviewer' || input.brief === false ? {} : { briefing: { hash: sha(`brief:${input.task}:${input.agent}`).padEnd(64, '0').slice(0, 64), omitted: 0,
      annotations: Object.values(state.decisions ?? {}).map((d, i) => ({ target: 'src/table.ts', scope: 'file', annotationId: `ann-${i}`, revisionId: `rev-${i}`, kind: 'rationale', content: d.rationale, attribution: d.decider })) } }) };
    state.lanes ??= {}; state.lanes[`${input.task}/${input.agent}`] = { task: input.task, agent: input.agent, seen: {} };
  }
  else if (command === 'ingest') {
    const results = [];
    for (const item of input.items) {
      const key = `${item.task}/${item.agent}`, previous = state.candidates[key];
      if (previous?.sourceSha === item.sha) { results.push({ agent: item.agent, task: item.task, status: 'duplicate', candidate: previous }); continue; }
      const candidate = { task: item.task, agent: item.agent, state: sha(item.sha + item.agent), sourceSha: item.sha, treeSha: sha('tree' + item.sha), parentSha: state.tasks[item.task].baseSha, subject: `Change by ${item.agent}`, diffstat: { files: 1, insertions: 1, deletions: 1 }, tests: { status: 'pass', passed: 14, failed: 0, summary: 'fixture tests', durationMs: 5 }, conflicts: [], signedBy: state.agents[item.agent].publicKey, capturedAt: '2026-10-10T12:00:00.000Z' };
      if (state.isolateUnreviewed && input.isolateUnreviewed) candidate.tests = { status: 'pending', passed: 0, failed: 0, summary: 'Isolated sandbox tests pending', durationMs: 0, provenance: 'isolated sandbox', sourceSha: item.sha };
      state.candidates[key] = candidate; state.lanes[key].seen[item.sha] = candidate;
      results.push({ agent: item.agent, task: item.task, status: 'captured', candidate });
    }
    for (const task of new Set(input.items.map(i => i.task))) if (state.tasks[task]) refreshCombined(state, task, !!(state.isolateUnreviewed && input.isolateUnreviewed));
    const conflicts = {};
    for (const candidate of Object.values(state.candidates)) {
      const others = Object.values(state.candidates).filter(c => c.task === candidate.task && c.agent !== candidate.agent);
      candidate.conflicts = others.length ? [{ path: 'src/table.ts', region: 'parseRow', with: others.map(c => c.agent) }] : [];
      conflicts[candidate.task] = candidate.conflicts;
    }
    result = { results, conflicts };
  }
  else if (command === 'combine') { refreshCombined(state, input.task, input.isolate === true); result = { task: input.task, candidates: Object.values(state.candidates).filter(c => c.task === input.task) }; }
  else if (command === 'tests.record' && input.combined) {
    const candidate = state.candidates[`${input.task}/${input.agent}`], combined = candidate?.combined;
    if (!combined || candidate.sourceSha !== input.sourceSha || combined.sha !== input.combined.sha || combined.mainSha !== state.mainSha || combined.tests?.status !== 'pending' || state.decisions[input.task]) result = { ignored: true };
    else if (input.run.sourceSha !== combined.sha || input.run.treeSha !== combined.treeSha) return { error: { code: 'test_binding_mismatch', message: 'SHA mismatch' } };
    else { combined.tests = isolatedTestResult(input.run); combined.status = combined.tests.status; result = { ignored: false, candidate }; }
  }
  else if (command === 'tests.record') {
    const candidate = state.candidates[`${input.task}/${input.agent}`];
    if (!candidate || candidate.sourceSha !== input.sourceSha || candidate.tests?.status !== 'pending' || state.decisions[input.task]) result = { ignored: true };
    else if (input.run.sourceSha !== candidate.sourceSha || input.run.treeSha !== candidate.treeSha) return { error: { code: 'test_binding_mismatch', message: 'SHA mismatch' } };
    else { candidate.tests = isolatedTestResult(input.run); result = { ignored: false, candidate }; }
  }
  else if (command === 'candidates') { const candidates = Object.values(state.candidates).filter(c => c.task === input.task); result = { heads: candidates.map(c => c.state).sort(), candidates }; }
  else if (command === 'captures') {
    let computed = 0, pending = 0; state.semanticDiffs ??= {};
    const lanes = Object.values(state.lanes ?? {}).filter(l => l.task === input.task && state.agents[l.agent].kind !== 'reviewer').sort((a, b) => a.agent.localeCompare(b.agent)).map(lane => {
      let from = state.tasks[input.task].baseState;
      return { agent: lane.agent, captures: Object.values(lane.seen).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || a.sourceSha.localeCompare(b.sourceSha)).map(c => {
        const key = JSON.stringify([from, c.state]);
        if (!state.semanticDiffs[key] && computed < 1) { computed++; state.semanticDiffs[key] = { status: 'ready', changes: [{ change_type: 'function_modified', description: 'Function modified: parseRow in src/table.ts', path: 'src/table.ts', old_name: 'parseRow', importance: 'medium' }] }; }
        const semantic = state.semanticDiffs[key] ?? { status: 'pending' }; if (semantic.status === 'pending') pending++;
        const capture = { ...c, fromState: from, semantic }; from = c.state; return capture;
      }) };
    });
    result = { task: input.task, lanes, pending, cacheChanged: computed > 0 };
  }
  else if (command === 'diff') result = { diff: `diff --git a/src/table.ts b/src/table.ts\n+${input.agent}\n` };
  else if (command === 'discuss') { const agent = state.agents[input.author]; result = { id: sha(input.opId), task: input.task, author: input.author, kind: agent.kind, body: input.body, ...(input.replyTo ? { replyTo: input.replyTo } : {}), heddleDiscussion: sha(input.task), signedBy: agent.publicKey, at: '2026-10-10T12:00:00.000Z' }; state.turns.push(result); }
  else if (command === 'decide') {
    const heads = Object.values(state.candidates).filter(c => c.task === input.task).map(c => c.state).sort();
    if (JSON.stringify([...input.expectHeads].sort()) !== JSON.stringify(heads)) return { error: { code: 'stale', message: 'Candidates changed' } };
    if (Object.values(state.candidates).some(c => c.task === input.task && c.tests?.status === 'pending')) return { error: { code: 'tests_pending', message: 'Tests pending' } };
    const picked = state.candidates[`${input.task}/${input.pick}`];
    const merged = state.tasks[input.task].baseSha !== state.mainSha && !state.containsMain?.includes(picked.sourceSha);
    const refusal = merged && combinedRefusal(picked, state.mainSha);
    if (refusal) return { error: refusal };
    result = { ...(merged ? { combined: { sha: picked.combined.sha, treeSha: picked.combined.treeSha, mainSha: picked.combined.mainSha, state: picked.combined.state } } : {}), task: input.task, decider: input.decider, pick: input.pick, rationale: input.rationale, alternatives: Object.values(state.candidates).filter(c => c.task === input.task && c.agent !== input.pick).map(c => c.agent), resolutionState: sha(input.opId + 'resolve'), landState: sha(input.opId + 'land'), mainSha: sha(sha(input.opId + 'land')), at: '2026-10-10T12:00:00.000Z' }; state.decisions[input.task] = result;
  }
  else if (command === 'publish') { const decision = Object.values(state.decisions).at(-1); state.mainSha = sha(decision?.landState ?? 'seed'); if (decision) decision.mainSha = state.mainSha; result = { main: state.mainSha, pushed: ['main', 'refs/notes/heddle', 'refs/notes/heddle-why'], verify: { exportRoundTrip: true, treeMatch: true, fsck: true } }; }
  else if (command === 'why') { const decision = Object.values(state.decisions).find(d => d.mainSha === input.sha); result = { narrative: decision ? `Heddle decision · task ${decision.task}\nChosen: ${decision.pick}\nRejected: ${decision.alternatives.join(', ')}\n${decision.rationale}` : 'Fixture candidate' }; }
  else if (command === 'selftest') result = { heddleVersion: 'stub', gitVersion: 'fixture', ok: true };
  else if (command === 'loaded') result = { loaded: null };
  else throw new Error('Unknown fixture command');
  if (input.opId) { state.ops[input.opId] = result; state.generation++; }
  return structuredClone(result);
}
