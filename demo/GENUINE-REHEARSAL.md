<!-- SPDX-License-Identifier: Apache-2.0 -->
# Genuine native-agent local rehearsal

`dev/genuine-rehearsal.mjs` is a local orchestrator around the existing entry.
It does not duplicate or replace the Worker, coordinator, engine, or stock
Heddle. The independent coding and reviewing work comes from actual native
collaboration tasks, not the prepared scripted candidates or an external CLI.

## Trust boundary and attribution

- Two real coding tasks edit separate enrolled Git forks and make local commits.
  They do not run candidate code or push before out-of-band review.
- The operator separately inspects the complete source, tests, configuration,
  file inventory/modes, and pinned dependency metadata. Only then does the
  operator extend a whole-tree manifest outside every candidate and engine
  state directory. This review can be delegated to an operator assistant; the
  evidence must say who reviewed it rather than imply a human review.
- No manifest supplied by a coding agent is trusted. The allowlist is a fixture
  approval gate, not a sandbox for arbitrary code.
- The orchestrator pushes the exact reviewed commit OIDs using ordinary Git.
  The unchanged engine verifies custodial Ed25519 capture signatures.
- A fresh native reviewer sees actual diffs, candidate test results, and the
  separately verified baseline regression failures. Its exact review is posted
  through the existing turns API using a newly enrolled reviewer role.
- Stock native discussion operations are unsigned. The existing engine signs
  an attestation containing their exact native envelopes; this is not a claim
  that the stock format or model provider signed the discussion.
- Provider is recorded as `openai-native-collaboration`. When the runtime does
  not expose an exact model, `runtime-selected-not-exposed` is an explicit
  unknown-model marker, not a claimed model name. Task identities are retained.
- The final selection is explicitly `SCRIPTED TEST CHOICE`, following the
  reviewer recommendation. It is not represented as a real human decision.

## Run phases

Use the prerequisites and cache preparation in `docs/LOCAL-INTEGRATION.md`.
Supply a fresh private `GENUINE_RUN_DIR`, an absolute
`HEDDLE_TRUSTED_TEST_MANIFEST` outside that directory, the stock `HEDDLE_BIN`,
and a safe `TMPDIR` containing the warmed operator-owned npm cache. Keep
Wrangler HOME/XDG configuration isolated and set `WRANGLER_SEND_METRICS=false`.
The initial manifest can contain the already-reviewed seed fixtures.

1. Run `node dev/genuine-rehearsal.mjs`. Wait for `evidence/ready.json`.
2. Assign two concurrent native coding tasks the returned separate fork paths.
   Have them preserve the lockfile and baseline tests, commit their work, and
   stop before execution or push. Record real task IDs and start/finish times.
3. Independently review every tree byte and inventory. Build manifest entries
   from the explicit reviewed files using `createReviewedFixtureEntry`; this
   function is a digest formatter, not an automatic approval decision. Include
   any separately reviewed baseline-plus-new-tests regression trees.
4. Atomically write the separate manifest. Then create
   `GENUINE_RUN_DIR/operator-approval.json` with `reviewedCompleteTrees: true`,
   `manifestSha256` (the SHA-256 of exact manifest bytes), review provenance,
   and `candidates` keyed by `native-scan` and `native-parity`, each with its
   exact `sourceSha`. The running orchestrator checks clean Git trees and OIDs
   before concurrent push. Wait for `evidence/review-input.json`.
5. A fresh independent native reviewer writes `native-review.json` at the run
   root with `provider`, `model`, actual `taskIdentity`, `sourceShas`, `summary`,
   `perCandidate`, `recommendation: { pick, why }`, actual checks and limitations.
   The orchestrator signs/posts that review, records the scripted choice, then
   verifies a fresh clone, original candidate refs, selected tree, strict fsck
   and index-pack, notes/trailers, and per-SHA publication verification.

The local reviewer alias fails closed rather than injecting a scripted or
Workers AI review while a genuine native reviewer is still working.

### Replay a prior genuine result

To test a later gateway fix without inventing another coding session, use a
fresh run directory and set `GENUINE_REPLAY_SOURCE` to the prior safe evidence
directory. Transfer the original candidate commits into the freshly enrolled
forks by local Git fetch and fast-forward, verifying their complete original
OIDs and tree OIDs. Reuse only the exact previously reviewed trees/manifest and
exact historical `native-review.json`; do not claim a new reviewer invocation.
The orchestrator records this distinction in the public discussion, rationale
and result metadata. The original evidence packet remains unchanged.

After the local services stop, `node dev/check-decision-replay.mjs <run-directory>`
checks the decision timestamp against its authentic native rationale operation
and the Git commit timestamp. It exports twice, snapshots/restores to a fresh
private directory, makes the original state temporarily unavailable, then
exports twice again. All four exports must reproduce the same SHA. Keep its
raw snapshot and restored custodial state private; export only the summary
`decision-time-stability.json` and separately verified public evidence.

## Evidence and recording

Copy an explicit allowlist of evidence files only. Safe material includes the
reviewed seven-file candidate trees, diffs, public keys/native IDs, manifest,
review approval, candidate test results, regression failures, exact review,
decision, fresh-clone log/refs, verification results, timings, and a concise
report. Verify the final allowlist contains no credentials or private keys.

Never copy `private/`, fork `.git/` directories, `ha-auth`, `ha.json`, engine
state, token-bearing Wrangler logs, process environments, or raw snapshots.
The private state may be retained locally for inspection, but is not an
attachment or recording source. Do not record Git configuration or the
Wrangler binding banner.

## Limits

This runs real Wrangler/workerd SQLite/R2 and the stock Heddle host process.
Artifacts smart HTTP remains the local fixture, the engine is not a deployed
Container, the reviewer is not Workers AI, and the decision is scripted.
There are no live cloud resources, account credentials, deployments, external
repository pushes, or public publication. A successful local rehearsal does
not establish the pending live-cloud or browser-recording checks.
