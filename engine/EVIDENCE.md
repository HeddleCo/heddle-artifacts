<!-- SPDX-License-Identifier: Apache-2.0 -->
# Track B acceptance evidence

## Ordered publication revalidation, 2026-10-10

The real-account transport probe confirmed ordinary main/candidate/notes pushes
but rejected `--atomic`. The earlier atomic-publication results below are
historical and superseded by the recoverable ordered protocol in
`engine/README.md`; they are not a claim about the current server or engine.

The local stock-Heddle aggregate was rerun after introducing decision-time frozen
inputs, immutable manifest history in the existing agents directory, checkpoint
recovery, exact-object readback, and main-last expected-parent CAS. It passed all
26 trusted-execution tests, B-T1–B-T6 acceptance and mutation controls, and the
complete hardening suite using Git 2.52.0 and unchanged Heddle 0.30.0. The
publication fixture explicitly disables `receive.advertiseAtomic`.

Independent `engine/test/ordered-independent.mjs` adds 20 passing adversarial
cases: first-stage directory refusal, partial proof writes, checkpoint-only and
pre-checkpoint snapshot restart, lost acknowledgement at each write boundary,
canonical main races, exact whitespace-bearing rationale, input/alias/receipt
tampering, malformed and duplicate manifests, and two successive real native
decisions with historical snapshot lookup. A copied-engine negative control that
removed explicit leases failed the deletion-between-read-and-push test: ordinary
Git receive-side CAS alone is insufficient to enforce the decision's expected
parent. The aggregate now runs this independent suite after the existing native
and hardening checks.

The updated real transcript also passed 65 JSON request/response schema checks
across all 13 JSON commands; removing a candidate signature still failed schema
validation. The operator-reviewed four-tree manifest remained unchanged.

Current hardening output:

```text
Publication recovery PASS: proof rejection leaves only pending auxiliary refs and unchanged main; atomic-disabled server succeeds; interrupted opIds remain bound; post-push interruption restores the exact main and immutable receipt
Publication race PASS: decided fork advancement cannot block signed closure or restored replay; original candidate refs and tamper guard preserved
Publication race PASS: unrelated fork advancement cannot block signed closure or restored replay; original candidate refs and tamper guard preserved
```

There is no all-refs-atomic guarantee. Pending auxiliary refs are intentionally
observable. Readers select immutable evidence by exact main through directory
first-parent history. Already-landed retries never rewrite aliases or rationale;
conflicting main, changed prepared refs, or missing legacy frozen inputs fail
closed. These local results do not imply a container deployment or production
Artifacts acceptance; those require their own verification.

## Local integration revalidation, 2026-10-10

The integrated Track A/B/C/D sources were rechecked locally with the stock
`heddle 0.30.0` binary at release commit
`878fea434d2eed86865c0daf3f3b1ab7da6d2e4f`, Git 2.47.3 and Node 24.19.0.
All repositories and identities were synthetic. No Cloudflare resources,
real credentials, external repository pushes or deployments were used.
Generated identities and private state are not included in this repository.

The original `engine/test/e2e.sh` passed B-T1–B-T6 and all five mutation
controls before changes. The same checks passed after narrow integration fixes:

- Fork names now match Track A's 63-character SHA-256 truncation contract.
- Committed opId replay is bound to canonical JSON input, not only its command.
- Publication pushes all refs atomically, failing closed on unsupported servers.
- Publication freezes the ingested candidate closure, independent of later
  external pushes to decided or unrelated still-open forks.

`engine/test/hardening.mjs` uses unchanged assertions against the original
engine as negative controls. The original engine failed each of these checks:

```text
long fork must match Track A
Changed-input replay observed exit 0; expected domain rejection 2
same opId must not replay an unrelated request
Rejected publication changed remote refs: true
a rejected ref must not expose a partial publication
```

After the fixes, the hardening checks report:

```text
Fork naming PASS: Track A SHA-256 truncation, 63-character boundary, suffix and short names agree
Changed-input replay observed exit 2; expected domain rejection 2
Replay binding PASS: reordered equivalent input replays; changed or unbound input is rejected without mutation
Rejected publication changed remote refs: false
Publication recovery PASS: rejected refs are atomic; unsupported servers fail closed; post-push interruption restores and replays the identical main SHA
Hardening fixture completed: all
```

The interruption fixture exits after Git acknowledges the push but before the
operation result is saved, restores the preceding snapshot, and retries the
same opId. It verifies the exact landing SHA and strict object integrity, then
checks that committed replay leaves every published ref unchanged.
`engine/test/e2e.sh` now includes these hardening checks after its mutations.

Independent review exposed another publication race: after the signed native
decision commits, a later fork push made the old publication check reject
`candidate_changed`. Its lane was already released, so ingest rejected the new
SHA and a second decision rejected `already_decided`. An unrelated still-open
fork could cause the same blockage. Both cases were reproduced against the
pre-fix engine with unchanged regression assertions.

`engine/test/publication-races.mjs`, included in the hardening suite, now reports:

```text
Publication race PASS: decided fork advancement cannot block signed closure or restored replay; original candidate refs and tamper guard preserved
Publication race PASS: unrelated fork advancement cannot block signed closure or restored replay; original candidate refs and tamper guard preserved
```

Each scenario checks the exact decided main SHA, original ingested candidate
refs, chosen tree, unchanged signed decision and proof, and replay from the
pre-publication snapshot. A post-close push is still rejected by ingest, and
tampering with a local candidate ref still rejects `candidate_drift` without
changing any remote ref. Only the dependency on mutable external fork tips was
removed. Independent review reran the original decided-lane race successfully
and confirmed that export pin, tree, round-trip, fsck and atomic guards remain.

The existing gate probe also passed again: independent G1 native signatures;
G2's observed `no_alternative_source_heads` and named b2 fallback; and G3's
identical fixed projection after restore, with a failing unpinned control.
Those gate implementations were not changed.

The shared schema runner reported:

```text
Contracts PASS: 57 real JSON request/response checks against Track A engine.schema.json; 13 JSON commands; snapshot verified separately as tar.zst
Contracts negative PASS: remove candidate signedBy → schema rejects the real response
```

The isolated locked Vitest fixture also passed, including its regression control:

```text
Vitest PASS: missing node_modules installed from lockfile; npm test --silent reports 1 passed within 60 seconds
Vitest negative PASS: deliberate assertion regression reports fail / 1 failed
```

This environment needs a proxy for registry access, whereas the engine
deliberately strips ambient authentication/proxy variables from test processes.
The first cold-cache attempt failed with `EAI_AGAIN`. The fixture's npm cache
was then populated using a normal shell `npm ci --ignore-scripts`; the complete
engine test rerun passed with its unchanged isolated environment. This is a
warm-cache result, not proof of direct cold-cache registry access from the engine.

Historical remaining boundaries at that checkpoint included real Artifacts
candidate/notes refs and atomic support. The current boundary is the approved
ordered-publication capability probe, not atomic support. Older snapshots remain readable, but old operation
records without an input fingerprint reject replay with `op_id_conflict`.
The fixed G3 fallback main carries native State/Change trailers and why proof;
stock machine notes stay attached to native exported commits, not remapped
onto that fixed fallback SHA. The native machine-note tree is preserved.
The Docker image was not rebuilt in this integration environment; previous
container/size results below are historical, not a new image verification.

## Trusted fixture execution gate, 2026-10-10

The prior runner could execute arbitrary candidate npm scripts with the
custodial engine UID. The integrated runner now refuses every complete tree
that is absent from the operator-owned SHA-256 allowlist. It runs approved
source bytes in a fresh private copy with no native metadata or pre-existing
`node_modules`. This closes the demonstrated arbitrary-candidate execution
path; it does not provide a sandbox for the approved code or its dependencies.

`node --test engine/test/trusted-tests.mjs` passes **26/26** checks. They include
a malicious script attempting to copy and overwrite an explicitly synthetic
engine-state sentinel, with a fake-npm marker proving rejection before any npm
spawn. The original sentinel remains unchanged and no attempted-read output is
created. Unknown scripts, changed tests/lockfiles, untracked executable files,
npm configuration, ignored content, extra directories, symlinks, hardlinks,
unsafe permissions and candidate-supplied manifests are refused. Cache checks
also reject symlinked, writable, state-contained or candidate-contained caches.

The native end-to-end test adds an unknown malicious fixture and verifies that
it is still a captured, signed candidate with tests withheld. Its output is:

```text
Trusted execution PASS: unknown malicious fixture remains a signed native candidate; npm execution withheld; synthetic custody sentinel unchanged and unread
```

The reviewed Vitest integration uses the shipped lockfile and an operator
manifest outside candidate/state. With the operator npm cache prewarmed, it
reports:

```text
Vitest PASS: reviewed source copied without metadata; locked dependencies installed fresh; npm test --silent reports 1 passed within 60 seconds
Vitest negative PASS: separately reviewed deliberate assertion regression reports fail / 1 failed
Vitest trust negative PASS: an unreviewed regression is withheld instead of executed
```

The initial cold-cache run could not complete installation within 60 seconds
under the sanitized subprocess environment; it failed closed. Prewarming
`$TMPDIR/heddle-npm-cache` avoids forwarding operator proxy/authentication
environment into test subprocesses. Each execution still gets fresh
`node_modules`, and npm verifies cached packages against the reviewed lockfile.

The expanded native transcript passes 65 JSON request/response schema checks
across all 13 JSON commands, including `tests.status: "skipped"`; the missing
`signedBy` negative control still fails validation. An independent review also
verified all four shipped default fixture trees, source mutation after snapshot
creation, the malicious marker case, manifest provenance and cache containment.
The final aggregate exits 0 with the 26-check guard suite, B-T1–B-T6 mutation
controls and all publication/replay/race hardening on the reviewed final code.
Image rebuild and live cloud checks remain
separate from these local results.

## Earlier Track B evidence

Recorded locally on 2026-10-10. No Cloudflare credentials or service were used.
Heddle is the published 0.30.0 at 878fea434d2eed86865c0daf3f3b1ab7da6d2e4f.
G1 and the named G2/G3 fallback evidence are in [GATES.md](GATES.md).

## B-T1 through B-T6, host

Command (exit 0):

```sh
HEDDLE_BIN=/home/scratch/heddle-0.30-bin/bin/heddle TMPDIR=/home/scratch bash engine/test/e2e.sh
```

Exact stdout:

```text
B-T1 PASS: one ingest batch; parser candidates alice↔bob; docs candidate carol clean
B-T2 PASS: all native signatures match enrolled keys; alice fork→bob rejected lane_mismatch; capture without token rejected
B-T4 PASS: stale expectHeads exits 2 with stale; every state file unchanged
B-T3 PASS: original candidate SHAs; chosen tree; export round trip; fresh fsck/index-pack --strict; Chosen: bob / Rejected: alice in git log
B-T5 PASS: fresh-directory restore; candidates byte-identical; restored publish same main SHA
Idempotency PASS: repeated lane/SHA batch returns duplicates
Collaboration PASS: native envelopes signed with enrolled reviewer/human keys; decision binds exact states and SHA; tampering rejected
Lifecycle PASS: restored checkout captures a new push; same-batch duplicate captured once; opId replay, diff and why verified
Evidence scratch: <TEMP_FIXTURE>
Baseline PASS: unchanged B-T1–B-T5 assertions pass before mutation
B-T1 negative PASS: disable conflict preview → unchanged acceptance fails (exit 1)
B-T2 negative PASS: disable native identity verification → unchanged acceptance fails (exit 1)
B-T4 negative PASS: remove stale-head guard → unchanged acceptance fails (exit 1)
B-T5 negative PASS: corrupt restored candidate metadata → unchanged acceptance fails (exit 1)
B-T3 negative PASS: skip export pin → {"exportRoundTrip":false,"treeMatch":true,"fsck":true}; round-trip assertion fails (exit 1)
B-T6 PASS: disabled identity guard fails B-T2; skipped export pin fails B-T3; all B-T1–B-T5 acceptance assertions have failure proofs
Mutation evidence: <TEMP_FIXTURE>
```

Each negative copies production sources to a fresh temporary directory and
changes one guard, while keeping acceptance assertions unchanged. B-T1 disables
conflict preview. B-T2 disables native signature verification and must reject a
real capture checked against the wrong enrolled key. B-T4 removes the stale-head
guard. B-T5 changes restored metadata and fails byte comparison. B-T3 skips the
fixed export pin on a previously committed snapshot and fails restored SHA
comparison. The source tree is never mutated by this suite.

The recovery extension makes the original state directory unavailable while
publishing and capturing from the restored checkout. Other checks cover invalid
lease tokens, forged Git authors, ordinary replies, signed native collaboration
envelopes, tampering, duplicate items in one batch, and committed opId replay.

## Same acceptance inside the non-root image

Command (exit 0):

```sh
DOCKER_CONFIG=/home/scratch/track-b-docker-config docker run --rm -e HEDDLE_BIN=/usr/local/bin/heddle --entrypoint bash heddle-artifacts-engine:track-b /opt/engine/test/e2e.sh
```

Exact stdout:

```text
B-T1 PASS: one ingest batch; parser candidates alice↔bob; docs candidate carol clean
B-T2 PASS: all native signatures match enrolled keys; alice fork→bob rejected lane_mismatch; capture without token rejected
B-T4 PASS: stale expectHeads exits 2 with stale; every state file unchanged
B-T3 PASS: original candidate SHAs; chosen tree; export round trip; fresh fsck/index-pack --strict; Chosen: bob / Rejected: alice in git log
B-T5 PASS: fresh-directory restore; candidates byte-identical; restored publish same main SHA
Idempotency PASS: repeated lane/SHA batch returns duplicates
Collaboration PASS: native envelopes signed with enrolled reviewer/human keys; decision binds exact states and SHA; tampering rejected
Lifecycle PASS: restored checkout captures a new push; same-batch duplicate captured once; opId replay, diff and why verified
Evidence scratch: <TEMP_FIXTURE>
Baseline PASS: unchanged B-T1–B-T5 assertions pass before mutation
B-T1 negative PASS: disable conflict preview → unchanged acceptance fails (exit 1)
B-T2 negative PASS: disable native identity verification → unchanged acceptance fails (exit 1)
B-T4 negative PASS: remove stale-head guard → unchanged acceptance fails (exit 1)
B-T5 negative PASS: corrupt restored candidate metadata → unchanged acceptance fails (exit 1)
B-T3 negative PASS: skip export pin → {"exportRoundTrip":false,"treeMatch":true,"fsck":true}; round-trip assertion fails (exit 1)
B-T6 PASS: disabled identity guard fails B-T2; skipped export pin fails B-T3; all B-T1–B-T5 acceptance assertions have failure proofs
Mutation evidence: <TEMP_FIXTURE>
```

## Locked Vitest dependencies

Command (exit 0): `TMPDIR=/home/scratch node engine/test/vitest.mjs`

```text
Vitest PASS: missing node_modules installed from lockfile; npm test --silent reports 1 passed within 60 seconds
Vitest negative PASS: deliberate assertion regression reports fail / 1 failed
```

## Shared JSON schema

Track A's contracts PR landed during the final checks. Main has been merged,
the temporary types copy removed, and the same real e2e transcript validated
against the landed schema. A scratch installation of ajv 8.17.1 and
ajv-formats 3.0.1 performs validation. Command (exit 0):

```sh
node engine/test/contracts.mjs contracts/engine.schema.json <TEMP_FIXTURE>/contract.jsonl /home/scratch/track-b-schema-validator/node_modules
```

```text
Contracts PASS: 57 real JSON request/response checks against Track A engine.schema.json; 13 JSON commands; snapshot verified separately as tar.zst
Contracts negative PASS: remove candidate signedBy → schema rejects the real response
```

## Docker build, size, versions and failure proofs

Build command (exit 0):

```sh
DOCKER_CONFIG=/home/scratch/track-b-docker-config docker build -f engine/Dockerfile -t heddle-artifacts-engine:track-b .
```

Verification command (exit 0):

```sh
TMPDIR=/home/scratch DOCKER_CONFIG=/home/scratch/track-b-docker-config node engine/test/docker.mjs
```

Exact stdout:

```text
Docker PASS: 338926309 bytes < 400000000; user=65532:65532
{"heddleVersion":"heddle 0.30.0","gitVersion":"git version 2.47.3","ok":true}
Docker version negative PASS: substitute Git for Heddle → selftest ok=false
Docker size negative PASS: revert minimal root filesystem → 550144445 bytes; under-400-MB assertion fails
```

The negative image reverts the minimal filesystem packaging and retains the
full Debian runtime. The same size and version assertions are executed against
the negative cases and their AssertionErrors are required.

## Integration risks

- G2 uses b2 and G3 uses the fixed commit-tree fallback. The absorbed agent
  State is the resolution anchor; the human decision is a custodial attestation
  of the exact native discussion-resolution envelope and decision fields.
- The real-account A-S1 ref/notes/token smoke and the ProjectDO exec/R2 recovery
  integration remain Track A/E work. If notes are rejected, §9 R1's notes branch
  fallback needs to be activated before deployment.
- Track D's actual seed is not on main. A locked Vitest fixture passes locally;
  first dependency installation needs registry access within the 60-second budget.
- Align long truncated fork names with Track A's hash algorithm. Short p--t--a
  names are tested. Candidate refs use fast-forward updates; merge upstream main
  before selecting an old task after another task lands.
