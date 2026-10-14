// SPDX-License-Identifier: Apache-2.0
import { digest } from './auth';
import type { Candidate } from '../contracts/types';
import type { TestRecipe } from './test-recipe';
export interface SandboxInput {
  project: string; task: string; agent: string; sourceSha: string; treeSha: string;
  remote: string; readCredential: string;
  /** The project's operator-set recipe; absent means the default npm ci / npm test. */
  recipe?: TestRecipe;
}
export interface SandboxRun {
  sourceSha: string; treeSha: string; output: string; durationMs: number; budgetMs?: number;
  installExitCode?: number; testExitCode?: number;
  failure?: 'timeout' | 'sandbox' | 'checkout' | 'output';
  fixture?: boolean;
  local?: boolean;
}
export interface TestRunner {
  run(input: SandboxInput): Promise<SandboxRun>; destroy(): Promise<void>;
  /** The runner is the user's own machine, not a Sandbox: its failures are labelled so too, whatever the environment says. */
  local?: boolean;
  /** Time a job may spend waiting in the runner's own queue, on top of its test budget (the runner enforces the budget once it starts). */
  queueAllowanceMs?: number;
}
/** How long the coordinator waits for a run: the test budget minus the time already used, plus whatever queueing the runner declares. */
export function sandboxDeadlineMs(budgetMs: number, elapsedMs: number, runner: { queueAllowanceMs?: number }): number {
  return Math.max(1, budgetMs + Math.max(0, runner.queueAllowanceMs ?? 0) - elapsedMs);
}
export async function sandboxId(project: string, candidate: Pick<Candidate, 'task' | 'agent' | 'sourceSha'>): Promise<string> {
  return `candidate-test-${await digest([project, candidate.task, candidate.agent, candidate.sourceSha].join('\0'))}`;
}
