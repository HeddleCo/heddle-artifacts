// SPDX-License-Identifier: Apache-2.0
// An agent can end its run having done the work but without committing or pushing it, for example by
// closing with an offer of next steps. Its sandbox is discarded afterwards, so that work would be lost.
// The lane then gets exactly one more turn in the same session. The runner never commits or pushes for it.

/** `git status --porcelain` and `git rev-list --count origin/main..HEAD`, as run in the lane's repository. */
export interface WorkState { statusExit: number; status: string; aheadExit: number; ahead: string }

/** True when the repository holds work that has not reached the fork: changes, or local commits not on origin. */
export function hasUnpushedWork(state: WorkState): boolean {
  // If git cannot answer, do not guess: a follow-up turn is only for work that is known to be there.
  if (state.statusExit !== 0 || state.aheadExit !== 0) return false;
  const ahead = Number.parseInt(state.ahead.trim(), 10);
  return state.status.trim() !== "" || (Number.isFinite(ahead) && ahead > 0);
}

export const FOLLOW_UP_PROMPT = [
  "Your run ended before your work reached your fork: this repository still has uncommitted changes",
  "or commits that are not on origin, and the sandbox is discarded when you finish.",
  "If the work is ready, commit it and run `git push origin HEAD:main`. Push nothing broken.",
  "Then end with your closing message for your teammates and the human who decides (3 to 5 sentences:",
  "your approach, the trade-off you chose and why, and your exact test result), with no status lines.",
  "If it is not ready, push nothing and say exactly what is missing.",
].join(" ");
