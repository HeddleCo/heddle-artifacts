// SPDX-License-Identifier: Apache-2.0
import type { Agent, Lane, Candidate, Turn, Review, Decision } from '../../contracts/types';
// These are §7.2 response envelopes; §7.1 defines their nested domain types.
export interface Task { slug: string; intent: string; status: string; thread?: string; baseSha?: string; lanes: Lane[]; candidates: Candidate[]; decision?: Decision }
export interface ProjectView { project: { id: string; canonicalRemote?: string } | string; agents: Agent[]; tasks: Task[] }
/** Whether the deployment can run AI review (Workers AI), and whether this project has a reviewer enrolled. */
export interface ReviewStatus { available: boolean; enrolled: boolean; model?: string }
export interface TaskView { task: Pick<Task, 'slug' | 'intent' | 'status' | 'thread' | 'baseSha'>; reviewer?: ReviewStatus; candidates: Candidate[]; turns: Turn[]; review?: Review; decision?: Decision; heads: string[] }
export interface PublicationVerification { sha: string; exportRoundTrip: boolean; treeMatch: boolean; fsck: boolean; checkedAt: string }
export interface WhyView { sha: string; narrative: string; decision?: Decision; deciderName?: string; candidate?: Candidate; verify?: PublicationVerification }
export class ApiError extends Error { constructor(public status: number, public code?: string) { super(status === 403 || status === 401 ? 'Access denied. Sign in with an operator session.' : code === 'invalid_anchor' ? 'Point this reason at a file in the tree being landed, optionally followed by :symbol (a plain identifier).' : code === 'invalid_tags' ? 'Use at most 8 tags, each 1–64 characters of A–Z, a–z, 0–9, _ . : / -.' : code === 'invalid_seed' ? 'That repository could not be used. It must be a public https address.' : code === 'invalid_test_recipe' ? 'Tests run with npm, npx or node only, for example: npm test.' : code === 'task_exists' || code === 'identity_exists' ? 'That name is already taken here. Choose another.' : code === 'invalid_slug' ? 'Names use lowercase letters, digits and single hyphens.' : `Request failed (${status}). Try again.`); } }
export const projectPath = (p: string) => `/api/projects/${encodeURIComponent(p)}`;
export const taskPath = (p: string, t: string) => `${projectPath(p)}/tasks/${encodeURIComponent(t)}`;
export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal,
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) {
    let code: string | undefined;
    try { const error = await response.json() as { error?: unknown }; if (typeof error.error === 'string') code = error.error; } catch { /* No server error text is shown. */ }
    throw new ApiError(response.status, code);
  }
  return await response.json() as T;
}
export async function diff(p: string, t: string, a: string, signal?: AbortSignal) {
  const response = await fetch(`${taskPath(p, t)}/candidates/${encodeURIComponent(a)}/diff`, { credentials: 'same-origin', signal });
  if (!response.ok) throw new ApiError(response.status);
  return (await response.text()).slice(0, 512 * 1024);
}
