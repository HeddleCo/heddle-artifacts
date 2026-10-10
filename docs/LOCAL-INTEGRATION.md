<!-- SPDX-License-Identifier: Apache-2.0 -->
# Run the integrated entry locally

This combines the edge, engine, board and demo tracks. It does not require a
Cloudflare account. Use Node 22+, Git 2.47.3, tar, zstd and the published Heddle
0.30.0 CLI from commit `878fea434d2eed86865c0daf3f3b1ab7da6d2e4f`.
The engine image builds that exact stock revision; no gateway patch is needed.

```sh
npm ci
npm ci --prefix ui
npm ci --prefix reviewer
export HEDDLE_BIN="$(command -v heddle)"
export TMPDIR="$(mktemp -d)"
# Populate the locked registry cache without giving candidate subprocesses
# the operator's proxy, API tokens or other ambient environment.
npm ci --prefix demo/seed-project --ignore-scripts --no-audit --no-fund \
  --cache "$TMPDIR/heddle-npm-cache"
npm run build
npm run typecheck
npm test
npm --prefix reviewer test
npm --prefix ui run test:unit
npm run test:real-flow
LOCAL_FLOW_EVIDENCE="$TMPDIR/storyline-result.json" npm run test:storyline-real
```

The last command runs all three prepared Git clients through the actual Worker,
local SQLite/R2 bindings and stock native engine. It checks original candidate
SHAs, the selected tree, fresh clone, explicit notes fetch, strict fsck/index-pack
and SHA-bound recorded publication verification. The Artifacts service and
reviewer are explicitly local fixtures; the engine is a host process rather than
a Cloudflare Container. The discussion and decision are scripted demo inputs.

Only reviewed complete candidate trees may run tests in the custodial engine.
The trusted manifest is outside the candidate checkout and cannot be extended
by a Git push. Changed scripts, source, lockfiles, configurations, symlinks or
unexpected files cause execution to be withheld. This is a fixture approval
gate, not a sandbox for arbitrary code. Genuine agent changes must be reviewed
and added to the trusted manifest before their test execution, or tested in a
separately isolated runner.

## Recovery behavior

- An opId retry must match its command, input and coordinator context.
- Authenticated board/task reads return the last committed coordinator snapshot
  while native ingestion and tests run. They wake recovery without waiting for
  it; candidate events/polling reveal the completed result. Native reads and
  mutations remain serialized.
- A decision fixes the reviewed candidate snapshot. Later fork pushes cannot
  change that decision or prevent publication of its retained objects.
- Artifacts rejected atomic push in the live A2 probe. Publication now uses an
  explicit main-last protocol: persist immutable decision inputs, stage a
  recoverable directory manifest and exact proof refs, verify them, then compare
  and swap main from its expected parent. Auxiliary aliases can be pending.
  Readers resolve the manifest for their exact main through directory history;
  there is no all-refs-atomic or rollback claim. See `engine/README.md`.
- A lost response after a successful push replays the same fixed landing SHA.
- Decision time and the fixed landing timestamp come from the native rationale
  turn created during the choice, rather than the earlier chosen Capture. The
  timestamp is retained across snapshots and exact retries.
- Until publication succeeds, the UI shows a pending decision with immutable
  choice/rationale and a retry action. Other project mutations cannot advance
  native main past that pending decision.
- The fixed G3 landing has native State/Change trailers and a why note. Stock
  machine notes are retained under native export SHAs, not relabeled as notes
  originally produced for the fallback commit.

## Remaining live checks

The separate [A-S1 smoke plan](SMOKE.md) needs a verified account and explicit
approval for its temporary resources and credentials. After that, deployment
and a real Container/R2/Artifacts/reviewer rehearsal require their own approved
scope. Local passes do not establish those cloud results. The repository is
still private until the owner approves publication.

The deployment configuration uses an explicit root Docker build context with
an exact runtime-source `.dockerignore` allowlist, one Container maximum and a
five-minute idle timeout. These are bounded single-project demo defaults, not
an enforceable billing cap. The actual image build, cold-start behavior and
account-specific charges still require verification before deployment.

The UI browser suite is runnable with `npm --prefix ui test`; local execution
in the current task was blocked before assertions by Chromium IPC permissions.
The supported cloud browser also could not reach this task's loopback service.
Unit/render results do not substitute for the pending visual rehearsal.
