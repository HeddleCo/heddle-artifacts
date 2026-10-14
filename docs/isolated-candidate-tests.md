<!-- SPDX-License-Identifier: Apache-2.0 -->
# Isolated candidate tests

The engine still executes only trees reviewed in `demo/trusted-test-trees.json`.
`trusted-tests.mjs` and its ownership, mode and tree checks are unchanged. Native
capture, custodial signing and reviewed-fixture tests remain inside HeddleEngine.

For an unreviewed capture, the Worker requests `isolateUnreviewed` and the engine
records tests as `pending`. ProjectDO persists a job derived from project, task,
agent and source SHA, issues a fork-only read token through the existing credential
ledger (at most 240 seconds), and calls a separate CandidateTestSandbox Durable
Object. Only project/task/agent/SHA/tree, a credential-free fork URL and that read
credential enter the runner request. The container receives no Worker bindings,
operator/API/write token or signing identity. Read authentication is process-local
to `git fetch`, and is absent from npm's environment and Git configuration.

The sandbox fetches the exact commit, verifies HEAD and tree, then runs the
project's test recipe. By default that is `npm ci --ignore-scripts` and `npm test`
with a 180-second deadline. An operator can set a different recipe when creating a
project (`tests` in `POST /api/projects`): setup steps and a test step, each an argv
array for `npm`, `npx` or `node` (never a shell), and a budget of 30 to 600 seconds.
Candidate code cannot change it, and it cannot be changed after creation. Setup
stops at the first failing step; only the test step's output is parsed. For
example, a pnpm workspace:

```json
"tests": { "setup": [["npx", "--yes", "pnpm@10", "install", "--frozen-lockfile", "--ignore-scripts"]],
           "test": ["npx", "--yes", "pnpm@10", "test"], "budgetSeconds": 420 }
```

Fetch, setup and tests share the deadline and a 64 KiB combined output budget. Every
instance is claimed once, has a 30-second inactivity timeout, and is destroyed in
`finally`; a failed destroy schedules a durable cleanup retry. ProjectDO starts at
most three jobs at once. The platform also enforces `max_instances: 3` with the
default Containers scheduling policy and a `standard-1` instance type (half a vCPU,
4 GiB), which a real repository's dependency install needs.

The trusted Worker forwards bounded observations to the journaled `tests.record`
engine command. The engine parses Node/Vitest totals from stdout, ignores any
supplied counts, and signs a detached ed25519 observation using its engine identity.
The signed payload binds project, task, agent, source SHA, tree, native Capture
state, result and observation time. The agent's native Capture signature remains
intact. Superseded SHAs, already observed candidates and decided/released lanes
ignore late results. Missing totals, installation errors, timeouts, output overflow,
SDK errors and failed teardown all produce fixed `error` summaries.

The observation and `isolated sandbox` provenance flow through candidate snapshots,
SHA-bound feed updates, board/compare badges, reviewer input and Why/Git notes.
Worker and engine decisions reject pending tests. Automatic review and review retry
also wait, preserving the existing stale-head and publication guards. The observed
counts describe untrusted test output; candidate-authored tests or logs can still
misrepresent correctness. The reviewer assesses the diff as well as these results.

Job receipts and observations persist before external work and engine recording.
After coordinator eviction, an interrupted run is destroyed and becomes `error`;
an already observed result is replayed through its existing engine operation ID.
Instances are never reused to retry uncertain outcomes. No bearer credential is
stored in job receipts, engine input or the credential ledger.

The SDK and helper image are both pinned to stable `1.0.0`, observed on 2026-10-12.
This uses `Files` from the current SDK with the default Containers lifecycle API.
The newer `durable_object` scheduling policy does not support `max_instances`, so
it is intentionally not selected here. Sources:
[Sandbox SDK requirements](https://developers.cloudflare.com/sandbox/reference/),
[Containers scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/),
[Container API](https://developers.cloudflare.com/containers/api/durable-object-container/).

`engine/Dockerfile.layer` overlays JavaScript, contracts and reviewed demo inputs
onto the supplied immutable engine image, with root ownership and no group/other
write bits. The production binary and original Dockerfile build stages are unchanged.
The orchestrator builds this layer; this work does not deploy or pull that base.

## Local verification

`DEV=1` uses the explicit `dev/fake-test-runner.ts` adapter; Worker tests can inject
that same adapter. Local results say `isolated sandbox (local fixture)`. Those are contract fixtures that execute no candidate code and
are not evidence of production Sandbox execution. `up local` (`cli/up.mjs`) is different: it runs candidates for real on the
user's own machine through `dev/local-test-runner.mjs`, with no container, and its results say `local run (not isolated)`.
The production entrypoint never imports this fake. `npm run test:worker` covers the real adapter against a fake
container, including a stalled SDK stream, and the coordinator against fake runner
observations. `npm run test:dev` covers parsing, signature verification, late SHA
rejection, provenance and the engine's execution boundary.

An optional local SDK/image check uses a dependency-free npm fixture:

```sh
TMPDIR=/home/scratch npx wrangler dev --local --config wrangler.sandbox-smoke.jsonc --port 8795
curl http://127.0.0.1:8795/
```

That separate configuration has no account credentials or production engine image.
It tests local container/SDK plumbing; it does not fetch an Artifacts candidate.
