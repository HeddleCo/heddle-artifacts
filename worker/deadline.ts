// SPDX-License-Identifier: Apache-2.0
// A hung platform call must never wedge a project's serial queue: every await on a container,
// binding or remote service settles within a bound, then fails into the existing retry/journal paths.
export class DeadlineError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DeadlineError'; }
}
export async function deadline<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(code)), ms); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
