// SPDX-License-Identifier: Apache-2.0
/** "1 lane", "2 lanes". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Show a person by name. Heddle attributions read "Name <email>"; the email is identity plumbing, not display. */
export const displayName = (attribution: string) => attribution.replace(/\s*<[^>]*>\s*$/, '') || attribution;
