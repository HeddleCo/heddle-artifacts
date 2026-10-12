// SPDX-License-Identifier: Apache-2.0
// Genuine native-agent reviews are posted through the existing turns API.
// Do not let the local scripted reviewer impersonate that independent review.
export function createReviewer() {
  return async () => { throw new Error('Independent native review must be posted explicitly'); };
}
