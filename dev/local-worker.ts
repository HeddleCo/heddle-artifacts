// SPDX-License-Identifier: Apache-2.0
// The Worker for `up local`: the production coordinator and API, with the real engine and the real local test runner.
// Unlike dev/test-worker.ts it carries no fixtures: tests are run, not invented, and there is no reviewer unless you enrol one.
import { fetchApi } from '../worker/api';
import { queue } from '../worker/events';
import { ProjectDO as Coordinator } from '../worker/project-do';
import type { Env } from '../worker/env';
import type { SandboxInput, SandboxRun, TestRunner } from '../worker/isolated-tests';

function localRunner(env: Env & { LOCAL_TEST_RUNNER_URL?: string; LOCAL_RUNNER_SECRET?: string }): { get(id: string): TestRunner } {
  return {
    get: () => ({
      run: async (input: SandboxInput): Promise<SandboxRun> => {
        if (!env.LOCAL_TEST_RUNNER_URL || !env.LOCAL_RUNNER_SECRET) throw new Error('local test runner is not configured');
        const response = await fetch(`${env.LOCAL_TEST_RUNNER_URL}/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-runner-secret': env.LOCAL_RUNNER_SECRET }, body: JSON.stringify(input) });
        if (!response.ok) throw new Error(`local test runner refused the run (${response.status})`);
        return await response.json() as SandboxRun;
      },
      destroy: async () => {},
    }),
  };
}

export class ProjectDO extends Coordinator {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, { ...env, TEST_RUNNER: localRunner(env) }); }
}
export default { fetch: fetchApi, queue };
