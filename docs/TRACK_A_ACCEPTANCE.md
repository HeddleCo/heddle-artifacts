<!-- SPDX-License-Identifier: Apache-2.0 -->
# Track A acceptance evidence

Track A implements the §7 HTTP API, SQLite ProjectDO, authenticated enrollment, Queue routing plus alarm polling, hibernatable WebSockets, reviewer calls, and serialized engine execution with durable journals and streamed R2 generations. Decisions can resume publication after failure without making a second native decision. Canonical read tokens support safe remote notes publication.

The local harness supplies scoped smart-HTTP Git repositories, the host engine bridge, explicit engine/reviewer fixtures, failure mutations, and live-account smoke tooling. Contracts were the first commit, published independently as [contracts: §7 types, PR #1](https://github.com/HeddleCo/heddle-artifacts/pull/1); that branch contains only the frozen §7 contracts.

| Item | Result | Evidence |
|---|---|---|
| A-T1 | ✅ | Idempotent fork/lane enrollment, exact short name, bounded hashed name |
| A-T2 | ✅ | Duplicate Queue event plus poll: one push, ingest op and capture |
| A-T3 | ✅ | Five concurrent pushes: one or two ingests; all captured; no 429; arrivals during exec get a second batch |
| A-T4 | ✅ | Missing/operator impersonation 403; stale exact heads 409; current heads land |
| A-T5 | ✅ | Partial mutation, engine disk loss and coordinator eviction: committed R2 restore and journal replay |
| A-T6 | ✅ | F1–F5 on Wrangler, fake-artifacts and the real Heddle 0.30.0 engine; fresh-clone SHA/tree/notes/fsck checks |
| A-S1 | ❌ | Real account unavailable: no Cloudflare credentials in sandbox |

A-T1–A-T5 use the prescribed `@cloudflare/vitest-pool-workers`, real local Workers/SQLite/R2, and an injected contract engine fixture. Exact verbose output (exit 0):
```sh
TMPDIR=/home/scratch WRANGLER_LOG_PATH=/tmp/track-a-wrangler.log npm run test:worker
```
```text
> test:worker
> vitest run --reporter verbose


=======================================================================================
WARNING: @cloudflare/vitest-pool-workers has been renamed to @cloudflare/vitest-plugin.
This package will not receive future updates.
Run `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` to migrate.
=======================================================================================


 RUN  v4.1.11 /home/heddleco/HeddleCo/workspace/heddle-artifacts-A

Sourcemap for "/home/heddleco/HeddleCo/workspace/heddle-artifacts-A/node_modules/@cloudflare/containers/dist/index.js" points to missing source files
Sourcemap for "/home/heddleco/HeddleCo/workspace/heddle-artifacts-A/node_modules/@cloudflare/containers/dist/lib/container.js" points to missing source files
Sourcemap for "/home/heddleco/HeddleCo/workspace/heddle-artifacts-A/node_modules/@cloudflare/containers/dist/lib/helpers.js" points to missing source files
Sourcemap for "/home/heddleco/HeddleCo/workspace/heddle-artifacts-A/node_modules/@cloudflare/containers/dist/lib/utils.js" points to missing source files
 ✓ worker/test/engine-container.test.ts > container wrapper passes argv/stdin/env separately and maps domain/crash exits 3ms
 ✓ worker/test/engine-container.test.ts > container snapshot exit failure aborts the streamed response 1ms
 ✓ worker/test/snapshot.test.ts > unknown-length exec stdout uploads through bounded multipart parts and round-trips byte-exactly 290ms
stdout | worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T1 enrollment is idempotent, exact fork name and bounded hashed names
A-T1 PASS: one fork/lane/enroll op, stable public key, hashed long names, only agent-key hash persisted

 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T1 enrollment is idempotent, exact fork name and bounded hashed names 380ms
 ✓ worker/test/snapshot.test.ts > a failed snapshot stream publishes no partial R2 generation 112ms
stdout | worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T2 duplicate Queue event plus poll produces exactly one ingest op
A-T2 PASS: duplicate event + alarm poll => one push row, one durable ingest op, one capture

 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T2 duplicate Queue event plus poll produces exactly one ingest op 336ms
stdout | worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T3 five concurrent pushes coalesce into one or two ingests and all capture
A-T3 PASS: five pushes accepted, five captured, 1 ingest exec(s), no 429

 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T3 five concurrent pushes coalesce into one or two ingests and all capture 738ms
 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T3 pushes received during an in-flight ingest become a second coalesced batch 1136ms
stdout | worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T4 decision rejects missing/agent operator auth and stale exact heads
A-T4 PASS: missing token 403, agent token 403, stale heads 409, current heads land and revoke lane token

 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T4 decision rejects missing/agent operator auth and stale exact heads 544ms
 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > failed publication retains readable metadata, revokes forks and an operator retry resumes the existing decision 963ms
stdout | worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T5 crash mid-ingest restores R2 and replays the same journaled op after DO eviction
A-T5 PASS: partial mutation + lost engine disk => R2 restore, same opId replay, one generation/candidate; pending journal replays after coordinator eviction

 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > A-T5 crash mid-ingest restores R2 and replays the same journaled op after DO eviction 756ms
 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > queue acknowledges durable receipt, retries routing failures, and reviewer posts with its enrolled key 779ms
 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > routes only main on a registered fork; dev hook is 404 outside DEV=1 283ms
 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > agent cannot impersonate another identity; private why and cross-origin cookie writes fail closed 462ms
 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > HTTP JSON and login bodies are bounded before parsing 8ms
 ✓ worker/test/control-plane.test.ts > Track A acceptance in real Workers + SQLite + R2 runtime > three crashes emit engine.error and domain rejections do not retry 705ms

 Test Files  3 passed (3)
      Tests  16 passed (16)
   Start at  20:44:16
   Duration  9.12s (transform 1.25s, setup 0ms, import 1.62s, tests 7.50s, environment 0ms)
```

Failure proof for every A-T1–A-T5 item: remove each production guard, require an assertion failure and nonzero exit, restore exact original bytes, then require the complete Workers suite to pass. These are production mutations, not fake failures.

```sh
TMPDIR=/home/scratch WRANGLER_LOG_PATH=/tmp/track-a-wrangler.log npm run test:negative
```
```text
> test:negative
> node dev/prove-tests.mjs

A-T1: mutant exit 1; AssertionError: {"error":"internal"}: expected 500 to be 200 // Object.is equality
A-T2: mutant exit 1; AssertionError: expected [ { …(5) }, { …(5) }, { …(5) } ] to have a length of 1 but got 3
A-T3: mutant exit 1; AssertionError: expected 5 to be less than or equal to 2
A-T4 (operator auth): mutant exit 1; AssertionError: expected 200 to be 403 // Object.is equality
A-T4 (stale heads): mutant exit 1; AssertionError: expected { error: 'stale' } to deeply equal { error: 'stale', …(1) }
A-T5: mutant exit 1; AssertionError: expected [] to have a length of 1 but got +0
Restored production sources: all Workers tests PASS; every A-T1–A-T5 guard mutation was caught.
```

A-T6 exact command and successful output (exit 0). Track B/D paths were read-only inputs; neither worktree was edited. The shared binary reports `heddle 0.30.0`, built from the user-specified published commit `878fea43`. The reviewer uses the specified local AI stub.

```sh
TMPDIR=/home/scratch \
HEDDLE_BIN=/home/scratch/heddle-0.30-bin/bin/heddle \
ENGINE_SCRIPT=/home/heddleco/HeddleCo/workspace/heddle-artifacts-B/engine/engine.mjs \
ENGINE_DEMO_SEED=/home/heddleco/HeddleCo/workspace/heddle-artifacts-D/demo/seed-project \
ENGINE_DEV_DIAGNOSTICS=1 \
WRANGLER_LOG_PATH=/tmp/track-a-wrangler.log \
npm run test:real-flow
```
```text
> test:real-flow
> node dev/local-flow.mjs

F1 PASS: project initialized via wrangler dev (real engine)
F2 PASS: two tasks; alice, bob, carol and reviewer enrolled; human identity registered
F3 PASS: three concurrent real Git pushes => two conflicting parser candidates + one clean docs candidate; exact source SHAs
F4 PASS: debounced reviewer discussion (stub); human reply recorded
F5 PASS: missing auth 403; stale heads 409; current decision lands and public why names chosen/rejected candidates
A-T6 PASS: full F1–F5 with real Heddle; canonical SHA/tree, original candidates, notes and fsck verified
```

A-T6 failure proof: the same real flow failed before the canonical read token fix in `worker/engine-client.ts`. Remote notes inspection could not authenticate; publication exhausted three attempts and the F5 assertion exited 1. Exact diagnostic output excerpt:

```text
F1 PASS: project initialized via wrangler dev (real engine)
F2 PASS: two tasks; alice, bob, carol and reviewer enrolled; human identity registered
F3 PASS: three concurrent real Git pushes => two conflicting parser candidates + one clean docs candidate; exact source SHAs
F4 PASS: debounced reviewer discussion (stub); human reply recorded
Engine command publish exit 1, code engine_failure at engine/lib/process.mjs:25:23
Engine command publish exit 1, code engine_failure at engine/lib/process.mjs:25:23
Engine command publish exit 1, code engine_failure at engine/lib/process.mjs:25:23
Flow assertion FAILED: API status 503, error engine_failed

503 !== 200
```

Supporting verification (exit 0):

```sh
TMPDIR=/home/scratch npm run typecheck
```
```text
> typecheck
> tsc --noEmit
```
```sh
TMPDIR=/home/scratch WRANGLER_LOG_PATH=/tmp/track-a-wrangler.log npm test
```
```text
> test
> vitest run && node --test dev/test/*.test.mjs


=======================================================================================
WARNING: @cloudflare/vitest-pool-workers has been renamed to @cloudflare/vitest-plugin.
This package will not receive future updates.
Run `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` to migrate.
=======================================================================================


 RUN  v4.1.11 /home/heddleco/HeddleCo/workspace/heddle-artifacts-A

Sourcemap for "/home/heddleco/HeddleCo/workspace/heddle-artifacts-A/node_modules/@cloudflare/containers/dist/index.js" points to missing source files
Sourcemap for "/home/heddleco/HeddleCo/workspace/heddle-artifacts-A/node_modules/@cloudflare/containers/dist/lib/container.js" points to missing source files
Sourcemap for "/home/heddleco/HeddleCo/workspace/heddle-artifacts-A/node_modules/@cloudflare/containers/dist/lib/helpers.js" points to missing source files
Sourcemap for "/home/heddleco/HeddleCo/workspace/heddle-artifacts-A/node_modules/@cloudflare/containers/dist/lib/utils.js" points to missing source files

 Test Files  3 passed (3)
      Tests  16 passed (16)
   Start at  20:41:43
   Duration  9.97s (transform 268ms, setup 0ms, import 549ms, tests 8.59s, environment 1ms)

§7 schema: 12 JSON commands/results accepted; missing opId, stdin credentials and unknown commands rejected
✔ §7 schema accepts every JSON fixture command/output and rejects missing opId, extra credentials and unknown verbs (81.143349ms)
✔ host engine-devserver streams bytes, isolates project roots, forwards env credentials, preserves exit 2 and suppresses stderr (402.438253ms)
FakeArtifacts: main, candidates, notes, atomic push, hook, fork scope, read-only, revoke and expiry verified
✔ smart HTTP: real Git push/fork/clone, scoped expiring tokens, notes, atomic refs and events (1436.740198ms)
✔ A-S1 ref evidence cannot pass with a missing ref or a substring match (1.059449ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1600.385604
```

A-S1 exact attempted command (exit 2); see `docs/SMOKE.md` for owner instructions and named fallbacks:

```sh
TMPDIR=/home/scratch bash scripts/smoke-artifacts.sh
```
```text
A-S1 BLOCKED: CF_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required outside the sandbox.
```

Local smoke verifies the script and Git behavior, without claiming A-S1 (exit 0):

```sh
TMPDIR=/home/scratch bash scripts/smoke-artifacts.sh --fake
```
```text
PASS main push
PASS create/fork/mint token
PASS candidate ref push
PASS notes push
PASS atomic multi-ref push
INFO non-fast-forward notes rejected; R1: parent rebuilt notes onto remote notes tip
PASS git ls-remote confirms main, candidates and notes
PASS fake hook pushed event; observed latency 79 ms
LOCAL-SMOKE PASS (not A-S1 real-account evidence)
```

Smoke failure proof: omit a required advertised ref; the real ref check exits 1:

```sh
TMPDIR=/home/scratch bash scripts/smoke-artifacts.sh --fake --prove-ref-check
```
```text
PASS main push
PASS create/fork/mint token
PASS candidate ref push
PASS notes push
PASS atomic multi-ref push
INFO non-fast-forward notes rejected; R1: parent rebuilt notes onto remote notes tip
SMOKE FAIL: ref_check_failed (credentials suppressed)
```

## Integration risks

- A-S1 is blocked only by absent Cloudflare credentials. Run scripts/smoke-artifacts.sh outside the sandbox; no deployment or real Queue/Container result is claimed.
- A-T6 used the read-only Track B engine worktree and Track D demo seed, with the shared published Heddle 0.30.0 binary. Repeat it after those PRs land. The dev reviewer is explicitly model:"stub"; production Wrangler aliases the import to Track D's createReviewer(env), with AI bound.
- Long fork names use full.slice(0,46) + "-" + SHA256(full).slice(0,16). Track B's current forkRemote uses the untruncated name, so that algorithm must be aligned for names over 63 characters; the demonstrated demo uses short names.
- Re-enrollment preserves identity/fork/lane but rotates agent and fork credentials. The §7 refresh route has no task selector; multiple active lanes for one agent return lane_ambiguous.
- Live notes/atomic acceptance and Queue delivery are unverified. Keep R3 polling enabled. Select R1 if live notes pushes fail; the engine's parent-chain fallback for rebuilt notes is used without force-pushing.
- Container wrapper streams exec output, keeps the image alive with a sleep entrypoint, sets two-hour inactivity, and bounds exec time. The actual Cloudflare container path awaits account integration; A-T6 used the host devserver.
- No CI checks are configured yet on this draft branch; local verification is recorded below. No other track directories were edited.
