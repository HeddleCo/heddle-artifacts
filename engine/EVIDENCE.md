<!-- SPDX-License-Identifier: Apache-2.0 -->
# Track B acceptance evidence

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
Evidence scratch: /home/scratch/track-b-e2e-UuBheL
Baseline PASS: unchanged B-T1–B-T5 assertions pass before mutation
B-T1 negative PASS: disable conflict preview → unchanged acceptance fails (exit 1)
B-T2 negative PASS: disable native identity verification → unchanged acceptance fails (exit 1)
B-T4 negative PASS: remove stale-head guard → unchanged acceptance fails (exit 1)
B-T5 negative PASS: corrupt restored candidate metadata → unchanged acceptance fails (exit 1)
B-T3 negative PASS: skip export pin → {"exportRoundTrip":false,"treeMatch":true,"fsck":true}; round-trip assertion fails (exit 1)
B-T6 PASS: disabled identity guard fails B-T2; skipped export pin fails B-T3; all B-T1–B-T5 acceptance assertions have failure proofs
Mutation evidence: /home/scratch/track-b-mutations-POFMPF
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
Evidence scratch: /tmp/track-b-e2e-8JrNKh
Baseline PASS: unchanged B-T1–B-T5 assertions pass before mutation
B-T1 negative PASS: disable conflict preview → unchanged acceptance fails (exit 1)
B-T2 negative PASS: disable native identity verification → unchanged acceptance fails (exit 1)
B-T4 negative PASS: remove stale-head guard → unchanged acceptance fails (exit 1)
B-T5 negative PASS: corrupt restored candidate metadata → unchanged acceptance fails (exit 1)
B-T3 negative PASS: skip export pin → {"exportRoundTrip":false,"treeMatch":true,"fsck":true}; round-trip assertion fails (exit 1)
B-T6 PASS: disabled identity guard fails B-T2; skipped export pin fails B-T3; all B-T1–B-T5 acceptance assertions have failure proofs
Mutation evidence: /tmp/track-b-mutations-L7FCYB
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
node engine/test/contracts.mjs contracts/engine.schema.json /home/scratch/track-b-e2e-UuBheL/contract.jsonl /home/scratch/track-b-schema-validator/node_modules
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
