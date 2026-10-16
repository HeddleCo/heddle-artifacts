// SPDX-License-Identifier: Apache-2.0
/** "1 lane", "2 lanes". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Show a person by name. Heddle attributions read "Name <email>"; the email is identity plumbing, not display. */
export const displayName = (attribution: string) => attribution.replace(/\s*<[^>]*>\s*$/, '') || attribution;

/**
 * A canonical remote that is safe to show and to paste into a copied command: HTTPS, or plain HTTP on this
 * machine (the `up local` git server), with no userinfo, query, fragment or shell syntax. Undefined otherwise.
 */
export function cloneRemote(remote?: string): string | undefined {
  let url: URL; try { url = new URL(remote || ''); } catch { return undefined; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback) || url.username || url.password || url.search || url.hash) return undefined;
  return /^[a-zA-Z0-9./:_\[\]-]+$/.test(remote!) ? remote : undefined;
}

/** Where tests ran, once they have run. A pending test has not run anywhere yet, so it names no runner. */
export const runnerLabel = (tests?: { status: string; provenance?: string }) => tests && tests.status !== 'pending' && tests.provenance ? tests.provenance : undefined;
/** What the combined-check line says about how the merged result is tested: the runner that did it, never a guess. */
export const combinedTestedNote = (tests?: { status: string; provenance?: string }) => {
  const runner = runnerLabel(tests) && tests?.status !== 'skipped' ? runnerLabel(tests) : undefined;
  return runner ? `The merged result was tested (${runner}).` : 'The merged result is tested before it can land.';
};
