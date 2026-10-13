<!-- SPDX-License-Identifier: Apache-2.0 -->
# Account-free local integration and preflight

Use Node 22+ on Linux or macOS and Git. The native story also needs tar, zstd
and stock Heddle 0.31.1 from source commit
`0b5eec40276510d2723a1572bdea0e9640e66e33`. There is no Cloudflare account,
remote repository, deployment, paid CI, or live model call in this recipe.
All writes and Git servers created by these checks are local fixtures.

## Clean setup, then one preflight command

From a fresh copy of the current source, explicitly install the lockfile-pinned
application dependencies once:

```sh
npm ci
npm ci --prefix reviewer
npm ci --prefix ui
# If a compatible Chromium is not already installed, explicitly provision it:
node ui/node_modules/@playwright/test/cli.js install chromium

# Read the exact bounded plan without starting checks or writing evidence:
node dev/preflight.mjs --plan
# Use a new/empty directory for each run:
node dev/preflight.mjs --output ../preflight-local
```

The setup commands can download dependencies/browser binaries. The preflight
itself never installs application dependencies or a browser, authenticates,
deploys, contacts a live model, or starts cloud CI. It invokes existing local
executables directly, with a fixed plan rather than arbitrary user commands.
Do not run it concurrently with source edits or another test using UI port 8788.
The check detects source changes during execution and fails rather than claiming
one coherent verified revision. Existing package scripts are unchanged.

The command runs root and UI typechecks, UI build, Worker and dev tests, reviewer
typecheck/tests, UI unit/render/API/interaction tests, six isolated UI guard
mutations, the reviewed-tree manifest check, and the real Playwright click suite
against the local mock Worker. It starts that browser suite even when Chromium
may be unavailable: launch failures remain failures. `CI=1` prevents adopting
an unrelated running server. `UI_TEST_URL` is rejected; no remote test target is
accepted. Project `.env*`, `.dev.vars*`, or `.npmrc` files in the root, UI,
or reviewer config scope cause a refusal without reading their contents; use a
clean source copy. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and `PLAYWRIGHT_BROWSERS_PATH` may
select an already-installed local browser. No browser security bypass is added.

Each check has a fixed timeout and output limit. Independent later checks still
run after a failure; dependent checks are marked blocked. `result.json` records
exit status, duration, per-check logs, current source-file SHA-256/modes, all four
lockfile hashes, Node/platform metadata, and before/after source digests. Paths
inside the report are relative and the logs redact common credential forms.
It does not capture an environment dump or the operator's auth home. Screenshots
and browser failure artifacts, when actually produced, remain beside the report.

Exit 0 means all selected local checks passed. A missing dependency, blocked
check, browser launch failure, timeout, source drift, or nonzero test exit makes
the preflight nonzero. An omitted native story is explicitly `not-requested`,
not a native pass. Local fixture success establishes neither cloud behavior nor
reviewer usefulness. The runner is not a network or arbitrary-code sandbox;
execute reviewed source on a suitable local test host.

## Optional native story with an explicit CLI

First obtain the stock CLI from the pinned source and verify its provenance.
The Linux CLI built into the engine image has SHA-256
`2537ed019d2b567aaf3432758ef258004d20c62e1df9b07c112b852af98d3db8`.
Other platform builds need their own provenance. Preflight checks version 0.31.1
and records the binary hash; version text alone does not attest source identity.

The existing native engine reconstructs locked dependencies inside fresh,
whole-tree-approved fixture copies. Prepare its content cache explicitly first:

```sh
export TMPDIR="$(mktemp -d)"
npm ci --prefix demo/seed-project --ignore-scripts --no-audit --no-fund \
  --cache "$TMPDIR/heddle-npm-cache"
# HEDDLE_BIN is the opt-in; no PATH discovery silently enables native execution.
HEDDLE_BIN="$(command -v heddle)" \
  node dev/preflight.mjs --output ../preflight-native
```

The explicit cache setup above may use the npm registry. During preflight, its
npm wrapper permits the native engine's existing reviewed-fixture `npm ci`
only with `--offline --ignore-scripts --no-audit --no-fund`; a cache miss is a
failure, never a download fallback. Application/browser installation stays
blocked. The default preflight disallows even that fixture install. Keep the
cache outside candidate and engine-state directories; it must be a regular,
operator-owned directory, not a symlink.

The native stage runs after the browser check even if browser launch failed;
that browser failure still makes the combined result nonzero. The stage uses
three scripted Git clients, the actual local Worker/workerd SQLite/R2 bindings,
and the stock native engine as a host process. Artifacts and reviewer are local
fixtures, and discussion/human decision inputs are scripted. It verifies original
candidate SHAs, selected tree, fresh clone, explicit notes fetch, strict
fsck/index-pack, and SHA-bound recorded publication proof. Its nonsecret proof is
saved as `native-storyline.json`; no Cloudflare Container is started.

The existing individual commands remain available:

```sh
npm run build
npm run typecheck
npm test
npm --prefix reviewer run check
npm --prefix reviewer test
npm --prefix ui run typecheck
npm --prefix ui run test:unit
npm --prefix ui test
npm run test:real-flow
LOCAL_FLOW_EVIDENCE="$TMPDIR/storyline-result.json" npm run test:storyline-real
```

Unlike preflight, the last two existing entrypoints do not enforce offline npm.
They require the explicit native CLI setup and reviewed dependency cache. Do not
mistake the fixtures' model badges, signed scripted human, or stub review for
fresh agent work or the historical user's live choice.

## What is verified, and what remains a gap

The completed October 11 live rehearsal is preserved in checkpoint v12's
`CLAUDE-HANDOFF.md` and its `FUNCTIONALITY-STATUS.json`. It is no longer pending:

- Actual Worker/Container/Artifacts setup, concurrent exact historical agent
  commits, distinct signed native captures, and guarded 56/70-test runs passed.
- The actual user's `native-parity` choice and exact rationale landed at main
  `6f1d1bd6e081d9d0795d3952dae437276054d1ce`, tree
  `01ee577e5987a2329d46390960abfcbdecb773cb`. Fresh Git/notes proof and strict
  integrity checks passed; four displayed custodial Ed25519 proofs verified.
- The public Why page was actually read in dedicated cloud Chrome. Its exact
  choice, rationale, main, and three displayed publication checks matched.
  That was a read-only page check; no screenshot was saved for that handoff.
- Actual Qwen transport/schema admission passed after a bounded retry. Its
  result echoed fallback text and did not provide a substantive assessment.
  The local exact-template repair does not establish useful live reviewing and
  does not detect all paraphrased echoes. No new model call has been made here.
- Standard live WebSocket observation and a forced deployed Container restart
  remain unverified. Stable Why readback and local restore tests have narrower
  scopes. The full browser click suite is separate from that public page read.

The actual stock-source image was built and used live. Its OCI manifest digest
is `sha256:085fc19e7bc673d97204ca07e636c95cb51054658e1b0282f349549004e97445`.
The cloud build disabled release LTO after two rustc SIGKILLs, retaining stock
source/default features; it is not byte-equivalent to an earlier Mac/CI image.
It was assembled daemonlessly and independently checked. Do not describe its
build as pending or assume a fresh build here reproduces the same image bytes.

The October 12 local repair worktree combines the three recorded live overlays,
the previously staged exact-template reviewer repair, and further local demo
hardening. Before aggregate preflight, root typecheck, 114 Worker tests, 90
reviewer tests, nine composed Worker/reviewer integration checks, 26 fixture
trust checks, and a 39.406-second full native scripted story passed. These are
local results, not a redeployment. Use this worktree's latest preflight report
and final repair report for results after all edits; the earlier v12 counts are
historical. Chromium had failed before opening a page in this executor; browser
acceptance must not be represented as passed by unit/SSR results or a failed
launch. The new preflight records this gap explicitly if it persists.

Cloud cleanup was verified on October 11 at 20:32:06 UTC; the hosted Worker and
owned Container, repositories, DOs, queue, subscriptions, and R2 bucket are gone.
Old hosted URLs are not a persistent demo. The retained private image has a
separate October 12 18:29:26 UTC retention deadline; this local recipe neither
extends it nor authorizes cloud changes. Further deployment, credential creation,
paid inference, or publication needs the applicable separate owner approval.
The one-Container maximum/five-minute idle settings are bounded demo defaults,
not an enforceable billing cap or established performance benchmark.

## Recovery and execution boundaries

- Only reviewed complete candidate trees may execute in the custodial engine.
  The trusted manifest lives outside candidate checkouts and cannot be extended
  by a Git push. Changed scripts, source, lockfiles, configuration, symlinks, or
  unexpected files withhold execution. This is a fixture gate, not an
  arbitrary-code sandbox. New agent changes need separate full-tree review or
  an isolated runner before execution.
- An opId retry must match command, input, and coordinator context. Authenticated
  board/task reads return the last committed coordinator snapshot during native
  ingestion/tests; events/polling reveal completion. Native mutations serialize.
- A decision freezes its reviewed candidate snapshot. Later fork pushes cannot
  rewrite it or prevent publication of retained objects. Decision/fixed landing
  time comes from the native rationale turn and survives snapshot/retry.
- Artifacts rejected atomic push in the live A2 probe. Publication persists
  immutable inputs, stages a recoverable directory manifest/exact proof refs,
  verifies them, then compare-and-swaps main from its expected parent. Auxiliary
  aliases may be pending. Readers resolve the manifest for their exact main
  through directory history; there is no all-refs-atomic or rollback claim.
- Lost acknowledgement replays the fixed landing SHA. Until publication succeeds,
  the UI retains the pending immutable choice/rationale and retry action; other
  project mutations cannot move native main past it.
- The fixed G3 landing carries native State/Change trailers and a why note. Stock
  machine notes remain under native export SHAs rather than being relabeled as
  originally produced for the fallback commit. See `engine/README.md`.
