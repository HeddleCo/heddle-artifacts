// SPDX-License-Identifier: Apache-2.0
import type { Decision } from '../../contracts/types';
import { isPublished } from './decision';
import { AnnotationCard } from './annotation-card';
export function DecisionNotice({ project, decision }: { project: string; decision: Decision }) {
  const published = isPublished(decision);
  return <section class={`notice ${published ? 'landed' : 'warning publication-pending'}`} role="status">
    <strong>{published ? `✓ Landed ${decision.pick} on main` : 'Decision recorded. Publication pending.'}</strong>
    {!published && <p>Recorded choice: {decision.pick} · decided by {decision.decider}. The signed choice and rationale are preserved.</p>}
    {decision.combined && <p class="muted">Landed as Heddle's merge with main {decision.combined.mainSha.slice(0, 10)}, tested as {decision.combined.sha.slice(0, 10)}.</p>}
    <AnnotationCard kind="Reason" content={decision.rationale} attribution={decision.decider} anchor={decision.anchor} tags={decision.tags}/>
    {published ? <a href={`/p/${encodeURIComponent(project)}/why/${encodeURIComponent(decision.mainSha)}`}>See why {decision.mainSha.slice(0, 10)} landed →</a>
      : <p>Retry publication to publish this same decision. No published commit is available yet.</p>}
  </section>;
}
