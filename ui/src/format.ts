// SPDX-License-Identifier: Apache-2.0
/** "1 lane", "2 lanes". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Show a person by name. Heddle attributions read "Name <email>"; the email is identity plumbing, not display. */
export const displayName = (attribution: string) => attribution.replace(/\s*<[^>]*>\s*$/, '') || attribution;

/** Where tests ran, once they have run. A pending test has not run anywhere yet, so it names no runner. */
export const runnerLabel = (tests?: { status: string; provenance?: string }) => tests && tests.status !== 'pending' && tests.provenance ? tests.provenance : undefined;
/** What the combined-check line says about how the merged result is tested: the runner that did it, never a guess. */
export const combinedTestedNote = (tests?: { status: string; provenance?: string }) => {
  const runner = runnerLabel(tests) && tests?.status !== 'skipped' ? runnerLabel(tests) : undefined;
  return runner ? `The merged result was tested (${runner}).` : 'The merged result is tested before it can land.';
};
