// SPDX-License-Identifier: Apache-2.0
import { git } from './process.mjs';
import { exportRoot, requestHash } from './state.mjs';
import { narrative } from './why.mjs';

// Freeze the semantic input at decision time. Paths, credentials, operation IDs,
// mutable fork tips and subsequent discussion are not publication inputs.
export async function freezePublicationInput(state) {
  for (const lane of Object.values(state.lanes).filter(item => item.candidate)) {
    if (Object.values(state.decisions).some(decision => decision.mainSha === lane.candidate.sourceSha)) continue;
    const decision = state.decisions[lane.task];
    state.narratives[lane.candidate.sourceSha] = decision ? state.narratives[decision.mainSha] : narrative(state, lane.task);
  }
  const input = JSON.parse(JSON.stringify({
    project: state.project, canonical: state.canonical, mainSha: state.mainSha,
    projection: state.projection, agents: state.agents,
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, { intent: task.intent }])),
    lanes: Object.fromEntries(Object.entries(state.lanes).filter(([, lane]) => lane.candidate)
      .map(([id, lane]) => [id, { task: lane.task, agent: lane.agent, candidate: lane.candidate }])),
    decisions: state.decisions, narratives: state.narratives, turns: state.turns,
    attestations: state.attestations, decisionAttestations: state.decisionAttestations,
    machineNotes: await git(exportRoot, ['rev-parse', 'refs/notes/heddle']),
  }));
  state.publicationInput = { hash: requestHash(input), input };
  // Keep the exact native note commit and candidate objects alive across later
  // exports/ingests and snapshots. These refs are local only, never pushed.
  await git(exportRoot, ['update-ref', `refs/heddle-input/${input.mainSha}/notes`, input.machineNotes]);
  for (const lane of Object.values(input.lanes)) await git(exportRoot, ['update-ref',
    `refs/heddle-input/${input.mainSha}/candidates/${lane.task}/${lane.agent}`, lane.candidate.sourceSha]);
}
