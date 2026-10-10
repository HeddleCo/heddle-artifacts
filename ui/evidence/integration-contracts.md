<!-- SPDX-License-Identifier: Apache-2.0 -->
# Local integration checks, 2026-10-10

The integrated UI and reviewer import `contracts/types.ts` directly. Their old local copies are removed.

## Passed in this task environment

- `npm --prefix ui run typecheck`
- `npm --prefix ui run build`
- `npm --prefix ui run test:unit`: 20 tests (7 publication-evidence guards, 7 in-process fixture HTTP/reducer checks, 6 decision-state/server-rendered notice checks)
- `node ui/test/decision-negative.mjs`: removing published-SHA gating, immutable recorded choice, or current heads each produces assertion failures
- `node ui/test/verification-negative.mjs`: removing SHA binding, failed-check handling, or boolean validation each produces assertion failures
- `npm --prefix reviewer run check`
- `npm --prefix reviewer test -- --reporter=verbose`: 17 tests
- `node demo/test/reviewer-mutations.mjs`: validation, fallback-label and retry mutations each produce assertion failures
- `git diff --check -- ui reviewer`

The reviewer has its own Vitest configuration. Without it, integrated test discovery inherits the root Worker configuration and finds no reviewer tests.

## Browser validation blocked, not passed

The suite now has 17 browser cases. The previous 15-case run could not launch Chromium; the two new publication-recovery cases have not been run. It covers the prior 9 flows, recorded publication verification (pass, fail, wrong SHA, malformed), repeated decision submission, reply cancellation, Back/Forward navigation, and recovery from failed/pending publication.

Attempted with the installed Chromium:

```sh
XDG_CONFIG_HOME=/tmp/heddle-c-config \
  npm_config_cache=/tmp/heddle-artifacts-npm-cache \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
  UI_SCREENSHOT_DIR=.local/integration-shots \
  npm --prefix ui test
```

Wrangler starts after specifying loopback and a fixed inspector port. Chromium exits before any test assertion with:

```text
FATAL:chrome/browser/process_singleton_posix.cc:297
Check failed: . socket() failed: Operation not permitted (1)
```

An approved escalation produced the same error. The separately available cloud browser could not reach this task's loopback server. No new screenshots or browser-negative proof are claimed. Run the 17 browser checks and `test:negative` in an environment supporting Chromium IPC before recording.

## Evidence boundaries

- Fixture contract tests execute request/response handlers in-process, not the real Worker/engine.
- `WhyView.verify` is optional `{ sha, exportRoundTrip, treeMatch, fsck, checkedAt }`.
- Verification is used only for the exact viewed SHA with complete booleans and timestamp. The UI labels it recorded publication evidence, not a live Artifacts recheck. Candidate SHA preservation remains a separate check.
- Missing, malformed or mismatched evidence retains the unavailable panel. Failing checks remain visibly failed.
- Workers AI is simulated in reviewer tests. Missing AI retains `model: "fallback"`, concerns, and no recommendation.
- No cloud deployment, account use, live credential setup or repository push was performed.

## Publication recovery

A signed decision without a complete published SHA is pending, never labeled landed and never given a Why link.
Its choice, signer and rationale are immutable. Publication retry posts those exact recorded values with current heads;
a failed first response re-reads the task before allowing another choice. Distinct 409 codes retain specific recovery messages.
The recovery suite includes server-rendered notices and a failed-publication fixture that rejects changed rationale before retry.
The final recovery transcript is `publication-recovery.txt`; it supersedes the earlier UI test count in `integration-contracts.txt`.
