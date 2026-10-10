// SPDX-License-Identifier: Apache-2.0
import type { ReviewInput } from '../worker/env';
import type { Review } from '../contracts/types';
// Local contract fixture; production Wrangler resolves the import to Track D.
export function createReviewer(): (input: ReviewInput) => Promise<Review> {
  return async input => ({ summary: 'Local reviewer fixture; inspect the actual diffs before deciding.', perCandidate: input.candidates.map(c => ({ agent: c.agent, verdict: 'concerns', notes: `Fixture only; tests ${c.tests?.status ?? 'skipped'}.` })), model: 'stub' });
}
