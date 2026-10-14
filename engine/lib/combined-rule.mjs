// SPDX-License-Identifier: Apache-2.0
// The landing rule for a pick from an older base. Pure, so the engine and the dev stub share it.

/**
 * Why a candidate behind main cannot land yet, as { code, message }, or undefined when Heddle merged
 * it with the current main cleanly and the merged result passed its isolated tests.
 */
export function combinedRefusal(candidate, mainSha) {
  const combined = candidate.combined;
  if (!combined || combined.mainSha !== mainSha || combined.candidateSha !== candidate.sourceSha || combined.status === 'pending')
    return { code: 'combined_pending', message: 'Main advanced; the check of this candidate combined with main has not finished' };
  if (combined.status === 'conflict')
    return { code: 'combined_conflict', message: `Heddle found conflicts with main in ${combined.conflicts.map(c => c.symbol ? `${c.path} (${c.symbol})` : c.path).join(', ')}; the agent must resolve them and push again` };
  if (combined.status === 'fail' || combined.status === 'error') {
    const t = combined.tests;
    return { code: 'combined_failing', message: t?.status === 'fail' ? `${t.failed} test${t.failed === 1 ? '' : 's'} fail combined with main; the agent must fix them on the combined commit and push again`
      : 'The combined result could not be tested; the agent must update its candidate from the combined commit and push again' };
  }
  if (combined.status !== 'pass') return { code: 'combined_untested', message: 'Main advanced; the result combined with main has not been tested yet' };
  return undefined;
}
