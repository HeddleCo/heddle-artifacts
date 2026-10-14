// SPDX-License-Identifier: Apache-2.0
// The Worker's side of the local test runner (dev/local-test-runner.mjs): one HTTP call per run.
import type { SandboxInput, SandboxRun, TestRunner } from '../worker/isolated-tests';

export interface LocalRunnerEnv { LOCAL_TEST_RUNNER_URL?: string; LOCAL_RUNNER_SECRET?: string }
// The runner queues up to 64 jobs behind its slots; the coordinator must not count that wait against a job's test budget.
// The runner enforces the budget itself once a job starts, so this only bounds a runner that has stopped answering.
const QUEUE_ALLOWANCE_MS = 30 * 60 * 1000;

/**
 * Every outcome is a result that says it is local: an unreachable, busy, shutting-down or misconfigured runner becomes a
 * `failure: 'sandbox'` run, so the board reads "Local run (not isolated) failed" and not a label guessed from settings.
 */
export function localRunner(env: LocalRunnerEnv, fetchImpl: typeof fetch = fetch): { get(id: string): TestRunner } {
  return {
    get: () => ({
      local: true, queueAllowanceMs: QUEUE_ALLOWANCE_MS,
      run: async (input: SandboxInput): Promise<SandboxRun> => {
        const failed: SandboxRun = { sourceSha: input.sourceSha, treeSha: input.treeSha, output: '', durationMs: 0, failure: 'sandbox', local: true };
        if (!env.LOCAL_TEST_RUNNER_URL || !env.LOCAL_RUNNER_SECRET) return failed;
        try {
          const response = await fetchImpl(`${env.LOCAL_TEST_RUNNER_URL}/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-runner-secret': env.LOCAL_RUNNER_SECRET }, body: JSON.stringify(input) });
          if (!response.ok) return failed;
          return await response.json() as SandboxRun;
        } catch { return failed; }
      },
      destroy: async () => {},
    }),
  };
}
