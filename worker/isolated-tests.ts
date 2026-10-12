// SPDX-License-Identifier: Apache-2.0
import { digest } from './auth';
import type { Candidate } from '../contracts/types';
export interface SandboxInput {
  project: string; task: string; agent: string; sourceSha: string; treeSha: string;
  remote: string; readCredential: string;
}
export interface SandboxRun {
  sourceSha: string; treeSha: string; output: string; durationMs: number;
  installExitCode?: number; testExitCode?: number;
  failure?: 'timeout' | 'sandbox' | 'checkout' | 'output';
  fixture?: boolean;
}
export interface TestRunner { run(input: SandboxInput): Promise<SandboxRun>; destroy(): Promise<void>; }
export async function sandboxId(project: string, candidate: Pick<Candidate, 'task' | 'agent' | 'sourceSha'>): Promise<string> {
  return `candidate-test-${await digest([project, candidate.task, candidate.agent, candidate.sourceSha].join('\0'))}`;
}
