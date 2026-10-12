// SPDX-License-Identifier: Apache-2.0
export function candidateLine(label, candidate, state) {
  const agent = state.agents[candidate.agent];
  const tests = candidate.tests ? `${candidate.tests.passed}/${candidate.tests.passed + candidate.tests.failed} (${candidate.tests.status})${candidate.tests.provenance ? ` · ${candidate.tests.provenance}` : ''}` : 'not run';
  const conflicts = candidate.conflicts.map(c => c.path + (c.region ? ':' + c.region : '')).join(', ');
  return `${label}:  ${candidate.agent} ${candidate.sourceSha} tests ${tests} signed ed25519:${candidate.signedBy} (${agent.provider || 'unknown'} / ${agent.model || 'unknown'})${conflicts ? ' conflicts: ' + conflicts : ''}`;
}

export function narrative(state, task, decision) {
  const candidates = Object.values(state.lanes).filter(lane => lane.task === task && lane.candidate).map(lane => lane.candidate).sort((a, b) => a.agent.localeCompare(b.agent));
  const lines = [`Heddle decision · task ${task}`, `Intent:    ${state.tasks[task].intent}`];
  for (const candidate of candidates) {
    lines.push(candidateLine(decision ? candidate.agent === decision.pick ? 'Chosen' : 'Rejected' : 'Candidate', candidate, state));
    if (candidate.tests?.observation) lines.push(`Test proof: ${JSON.stringify(candidate.tests.observation)}`);
    const combined = candidate.combined;
    if (combined) {
      const t = combined.tests, verdict = combined.status === 'conflict' ? `Heddle conflicts: ${combined.conflicts.map(c => c.symbol ? `${c.path} (${c.symbol})` : c.path).join(', ')}` : `Heddle merge ${combined.heddle.mergeType}, ${combined.heddle.conflictCount} conflicts`;
      lines.push(`Combined:  ${candidate.agent} with main ${combined.mainSha}${combined.sha ? ` as ${combined.sha}` : ''} · ${verdict}${t && t.status !== 'skipped' ? ` · tests ${t.passed}/${t.passed + t.failed} (${t.status})` : ''}`);
      if (t?.observation) lines.push(`Combined proof: ${JSON.stringify(t.observation)}`);
    }
  }
  for (const turn of state.turns.filter(turn => turn.task === task)) {
    const author = state.agents[turn.author];
    lines.push(turn.kind === 'reviewer' ? `Review:    ${turn.author} (${author.provider || 'unknown'}/${author.model || 'unknown'}): ${turn.body}` : `Discussion: ${turn.author}: ${turn.body}`);
    if (state.attestations?.[turn.id]) lines.push(`Turn proof: ${JSON.stringify(state.attestations[turn.id])}`);
  }
  if (decision) {
    lines.push(`Rationale: ${decision.rationale}`);
    if (decision.combined) lines.push(`Landed:    ${decision.pick} merged with main ${decision.combined.mainSha} by Heddle; tested as ${decision.combined.sha}`);
    lines.push(`Decided by ${decision.decider} ed25519:${state.agents[decision.decider].publicKey} · resolution ${decision.resolutionState} · land ${decision.landState}`);
    const proof = state.attestations?.[state.decisionAttestations?.[task]];
    if (proof) lines.push(`Decision proof: ${JSON.stringify(proof)}`);
  }
  return lines.join('\n');
}
