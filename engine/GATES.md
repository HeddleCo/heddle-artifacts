<!-- SPDX-License-Identifier: Apache-2.0 -->
# Heddle 0.30.0 gates

Pinned CLI: `878fea434d2eed86865c0daf3f3b1ab7da6d2e4f` (`heddle 0.30.0`).
Run: `HEDDLE_BIN=/home/scratch/heddle-0.30-bin/bin/heddle TMPDIR=/home/scratch node engine/test/gates.mjs`.

G1 passes. Hand-written, mode-0600 `device-identity.toml` files in separate
`HEDDLE_HOME`s sign ordinary captures and `agent capture`. The engine verifies
Ed25519 attachments from the stock v4 snapshot pack against the recomputed
`heddle show --output json` content hash. `show` itself omits the public key;
this independent attachment verification closes that inspection gap.

G2 selects **fallback b2**. `agent fanout start` creates both checkouts and
leases; explicit reserve and token-authenticated capture work on each. Overlap
does not create the ADR-0053 source heads required by this design:

```text
heddle thread absorb task/parser/alice --into task/parser
Fast-forwarded task/parser to hs-v6afv0yebmv66np
heddle thread absorb task/parser/bob --into task/parser
Thread 'task/parser/bob' is stale and has 1 path conflict(s); merge did not run
heddle resolve --heads
Thread 'task/parser' has no alternative source heads
heddle resolve --pick hs-jc8gyhsjp0dgdbg57dpfczd673252vek7wezzs1e5kap4mf7e9y0
exit 74: no_alternative_source_heads
```

The adapter uses `git merge-tree --write-tree --merge-base <task-base>` for
conflict previews and `heddle thread absorb <chosen> --into <task-thread>`
for decisions, then releases the other leases as abandoned. Fast-forward
absorption retains the selected agent's signed State. The human's native
discussion resolution records the decision and extracts its rationale
annotation. Local discussion envelopes are unsigned in this CLI; the engine
signs their exact bytes with the author's enrolled key and includes the proof
in why notes. The decision attestation binds both State IDs and the Git SHA.
`resolutionState` names the absorbed State; it is not presented as
an ADR-0053 conflict resolution State.

G3 selects the named **fixed `git commit-tree` fallback**. With the stock
`land` followed by stock `bridge git export`:

```text
heddle land --thread task/g3 -m 'Chosen: bob
Heddle-Task: g3'
Landed thread 'task/g3'
heddle bridge git export --destination <fresh-bare>
exit 74: exported 2 refs, 1 diverged (concurrent git-side update): refs/heads/task/g3/bob
```

The partial stock export provides the native landed tree and unmodified
`refs/notes/heddle`. The adapter only accepts that specifically classified
partial-ref error, checks the landed tree against the chosen candidate, and
mirrors it with `git commit-tree`. Parent, author, timestamp and complete
message are persisted as the export pin. The message carries the exact native
land State, native Change, task, decider, chosen and alternative trailers.
A restored snapshot runs stock export and the same fixed commit construction;
the SHA must match. Candidate refs always retain the agent's original SHA.

The Git landing commit is the named fallback projection, not the raw stock
export commit. No Heddle sources are modified and no unpublished code is used.

Initial acceptance command:

```sh
TMPDIR=/home/scratch bash engine/test/e2e.sh
```

```text
B-T1 PASS: one ingest batch; parser candidates alice↔bob; docs candidate carol clean
B-T2 PASS: all native signatures match enrolled keys; alice fork→bob rejected lane_mismatch; capture without token rejected
B-T4 PASS: stale expectHeads exits 2 with stale; engine state unchanged
B-T3 PASS: original candidate SHAs; chosen tree; export round trip; fresh fsck/index-pack --strict; Chosen: bob / Rejected: alice in git log
B-T5 PASS: fresh-directory restore; candidates byte-identical; restored publish same main SHA
Idempotency PASS: repeated lane/SHA batch returns duplicates
```
