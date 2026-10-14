// SPDX-License-Identifier: Apache-2.0
// The Worker for `up local`: the production coordinator and API, with the real engine and the real local test runner.
// Unlike dev/test-worker.ts it carries no fixtures: tests are run, not invented, and there is no reviewer unless you enrol one.
import { fetchApi } from '../worker/api';
import { queue } from '../worker/events';
import { ProjectDO as Coordinator } from '../worker/project-do';
import type { Env } from '../worker/env';
import { localRunner, type LocalRunnerEnv } from './local-runner-adapter';

export class ProjectDO extends Coordinator {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, { ...env, TEST_RUNNER: localRunner(env as Env & LocalRunnerEnv) }); }
}
export default { fetch: fetchApi, queue };
