// SPDX-License-Identifier: Apache-2.0
// `up local` has no AI reviewer. The coordinator skips review when no reviewer agent is enrolled, so this is never called;
// if it ever is, it fails loudly instead of returning an invented verdict.
import type { ReviewInput } from '../worker/env';
import type { Review } from '../contracts/types';
export function createReviewer(): (input: ReviewInput) => Promise<Review> {
  return async () => { throw new Error('No reviewer is configured for the local stack'); };
}
