// SPDX-License-Identifier: Apache-2.0
import type { ProjectDO } from './project-do';
import type { Review, Turn, Candidate } from '../contracts/types';
export interface RepoInfo { name: string; remote: string; defaultBranch: string; }
export interface RepoToken { id: string; plaintext: string; expiresAt: string; }
export interface ArtifactsRepo extends Disposable {
  info(): Promise<RepoInfo>;
  fork(name: string, options: { defaultBranchOnly: boolean }): Promise<RepoInfo & { token?: string }>;
  createToken(scope: 'read' | 'write', ttl: number): Promise<RepoToken>;
  revokeToken(token: string): Promise<boolean>;
  log(options: { ref: string; limit: number }): Promise<Array<{ id: string }>>;
}
export interface ArtifactsBinding {
  create(name: string, options?: { setDefaultBranch: string }): Promise<RepoInfo & { token?: string }>;
  get(name: string): Promise<ArtifactsRepo>;
}
export interface ReviewInput {
  intent: string; base: string; candidates: Array<{ agent: string; diff: string; tests: Candidate['tests'] }>; turns: Turn[];
}
export interface EngineExecutor { fetch(request: Request): Promise<Response>; }
export interface Env {
  PROJECT: DurableObjectNamespace<ProjectDO>;
  ENGINE: DurableObjectNamespace;
  ARTIFACTS?: ArtifactsBinding;
  STATE: R2Bucket;
  EVENTS?: Queue;
  AI?: Ai;
  ASSETS?: Fetcher;
  OPERATOR_TOKEN: string;
  CF_EVENTS_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  EVENTS_QUEUE_ID?: string;
  ARTIFACTS_NAMESPACE?: string;
  DEMO_PROJECT?: string;
  DEMO_CREDENTIAL_TTL_SECONDS?: string;
  DEV?: string;
  FAKE_ARTIFACTS_URL?: string;
  ENGINE_DEV_URL?: string;
  // Track D can bind its pure review(input) through this adapter.
  REVIEW?: { review(input: ReviewInput): Promise<Review> };
}
