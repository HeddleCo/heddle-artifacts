// SPDX-License-Identifier: Apache-2.0
// The agent's closing message, posted once to its task discussion; long transcripts are not.
export const MAX_ANNOUNCEMENT = 4000;

/** Some models leak chat-template control tokens (for example <|channel|>final ... <|return|>). */
export function cleanAnnouncement(text: string): string {
  return text.replace(/<\|channel\|>\s*\w+/gi, " ").replace(/<\|[a-z_]{1,24}\|>/gi, " ").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_ANNOUNCEMENT);
}
