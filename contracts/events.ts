// SPDX-License-Identifier: Apache-2.0
export interface ArtifactsPushEvent {
  type: "cf.artifacts.repo.pushed";
  source: { repoName: string; namespace?: string; [key: string]: unknown };
  payload: { ref: string; before: string; after: string;
    commits: Array<{ sha?: string; author: unknown; committer: unknown;
      message: string; parents: string[]; [key: string]: unknown }>;
    [key: string]: unknown };
  [key: string]: unknown;
}
export function isMainPush(value: unknown): value is ArtifactsPushEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<ArtifactsPushEvent>;
  return e.type === "cf.artifacts.repo.pushed" &&
    typeof e.source?.repoName === "string" && e.payload?.ref === "refs/heads/main" &&
    typeof e.payload.after === "string" && /^[a-f0-9]{40}$/.test(e.payload.after) &&
    e.payload.after !== "0".repeat(40);
}
