// SPDX-License-Identifier: Apache-2.0
import type { PublicationVerification, WhyView } from './api';
/** Never apply another commit's verification or turn incomplete evidence into a green badge. */
export function publicationEvidence(view: WhyView | undefined, requestedSha: string): (PublicationVerification & { passed: boolean }) | undefined {
  const verify = view?.verify;
  if (!verify || view.sha !== requestedSha || verify.sha !== requestedSha ||
      !['exportRoundTrip', 'treeMatch', 'fsck'].every(key => typeof verify[key as keyof PublicationVerification] === 'boolean') ||
      typeof verify.checkedAt !== 'string' || !Number.isFinite(Date.parse(verify.checkedAt))) return;
  return { ...verify, passed: verify.exportRoundTrip && verify.treeMatch && verify.fsck };
}
