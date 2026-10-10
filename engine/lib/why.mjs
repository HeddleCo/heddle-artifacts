// SPDX-License-Identifier: Apache-2.0
export function candidateLine(label, candidate, state) {
  const agent = state.agents[candidate.agent];
  const tests = candidate.tests ? `${candidate.tests.passed}/${candidate.tests.passed + candidate.tests.failed} (${candidate.tests.status})` : 'not run';
  const conflicts = candidate.conflicts.map(c => c.path + (c.region ? ':' + c.region : '')).join(', ');
  return `${label}:  ${candidate.agent} ${candidate.sourceSha} tests ${tests} signed ed25519:${candidate.signedBy} (${agent.provider || 'unknown'} / ${agent.model || 'unknown'})${conflicts ? ' conflicts: ' + conflicts : ''}`;
}

export function narrative(state, task, decision) {
  const candidates = Object.values(state.lanes).filter(lane => lane.task === task && lane.candidate).map(lane => lane.candidate).sort((a, b) => a.agent.localeCompare(b.agent));
  const lines = [`Heddle decision · task ${task}`, `Intent:    ${state.tasks[task].intent}`];
  for (const candidate of candidates) lines.push(candidateLine(decision ? candidate.agent === decision.pick ? 'Chosen' : 'Rejected' : 'Candidate', candidate, state));
  for (const turn of state.turns.filter(turn => turn.task === task)) {
    const author = state.agents[turn.author];
    lines.push(turn.kind === 'reviewer' ? `Review:    ${turn.author} (${author.provider || 'unknown'}/${author.model || 'unknown'}): ${turn.body}` : `Discussion: ${turn.author}: ${turn.body}`);
  }
  if (decision) {
    lines.push(`Rationale: ${decision.rationale}`);
    lines.push(`Decided by ${decision.decider} ed25519:${state.agents[decision.decider].publicKey} · resolution ${decision.resolutionState} · land ${decision.landState}`);
  }
  return lines.join('\n');
}
