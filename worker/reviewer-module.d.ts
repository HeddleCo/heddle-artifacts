// SPDX-License-Identifier: Apache-2.0
declare module 'heddle-reviewer' {
  export function createReviewer(env: Pick<import('./env').Env, 'AI'>): (input: import('./env').ReviewInput) => Promise<import('../contracts/types').Review>;
}
