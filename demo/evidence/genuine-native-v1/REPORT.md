<!-- SPDX-License-Identifier: Apache-2.0 -->
# Genuine native-agent local rehearsal: PASS

Date: 2026-10-10 UTC. This is a new functional local rehearsal through the existing Heddle Artifacts entry, with two concurrent real coding tasks and a fresh independent native reviewer. No production Worker or engine logic was changed for the rehearsal.

## Result

- Scanner original commit: 167c9385e04e1b9028588f6534b51c5e1c398494; 56/56 tests pass (42 new, 14 baseline).
- Parity original commit: 299f09558f9bb50b99127c122dcaa827a98752c1; 70/70 tests pass (56 new, 14 baseline).
- Both are conflicting signed native candidates on src/table.ts and test/escapes.test.ts. Both original Git OIDs remain exactly addressable in the published candidate refs.
- Fresh reviewer approved both and recommended parity for its systematic unknown-escape and long-run regression coverage, not merely its larger test count.
- The explicitly labeled SCRIPTED TEST CHOICE selected parity. Canonical landing: beab62afbd2c660d8753e8210e9529b131cb0a1e.
- Chosen and landed Git tree: 01ee577e5987a2329d46390960abfcbdecb773cb.
- Selected native State: hs-fw8f0k3pwvf3q91xrp8ev1b1x4fj6bm1g485pq0503qm9d1f6kmg.
- Reviewer native discussion: disc-01a127a4-c9e7-73de-b671-3efd8dc2c26c.
- Reviewer native operation: co-aapddt5jp4fpzpv3hphnsvyvdbf2zw64aj01tg3km3bf9ncj336g.

## Checks actually completed

1. Two real native coding tasks overlapped for 69 seconds, each working only in its own independently enrolled local Git fork. Neither ran npm/candidate code or pushed before the separate review.
2. The operator assistant inspected complete seven-file source trees, tests, configuration, file modes/inventory, and all unchanged locked dependency metadata. A separate manifest was written outside candidate and engine-state directories. This is assistant review, not a human review claim.
3. Both exact commits were pushed concurrently using ordinary Git over the local Artifacts smart-HTTP fixture. Existing Worker/SQLite/R2 coordination and the stock native engine produced the captures, tests and conflicts.
4. The new suites failed on the unchanged baseline: scanner 31 failures / 25 passes; parity 46 failures / 24 passes. Those regression trees were separately approved and never pushed.
5. An independent reviewer executed 390,544 behavioral cases per candidate: 335,923 exhaustive small inputs, 32,776 targeted long/parity inputs, and 21,845 baseline-compatibility inputs. Suites overlap; this is an executed-case count, not unique-input count. A separately timestamped confirmation script and captured output are included.
6. The existing guard authorized an exact reviewed tree, then withheld a tree with an unexpected file before npm. This remains a fail-closed reviewed-fixture gate, not a sandbox.
7. Fresh clone, explicit notes fetch, exact candidate refs, selected-tree equality, strict fsck and strict index-pack all passed. The why note retains chosen/rejected alternatives, actual reviewer text, rationale and native State/Change trailers.
8. SHA-bound recorded publication verification passed exportRoundTrip, treeMatch and fsck for the landing above.
9. A separate public-evidence verifier validated all four Ed25519 native-envelope attestations, envelope SHA-256 hashes, exact reviewer body/operation ID and keys against the published agent directory. Stock local discussions are unsigned; these are the existing gateway's custodial signatures over exact native envelopes.
10. Entry npm run typecheck, JavaScript syntax checks and changed-brief whitespace checks passed. The frozen v0 checkpoint was not modified.

## Timing and provenance

- Scanner coding: 21:02:50–21:04:14 UTC (84s).
- Parity coding: 21:03:05–21:04:28 UTC (83s).
- A pre-push runtime restart corrected a local proof assertion's whitespace handling. Original coding forks and commits were preserved. Local Git fetch/fast-forward transferred the same OIDs into freshly enrolled forks before review/push.
- Successful restarted runtime: 21:04:12.854–21:07:59.837 UTC, 226.983s.
- Original runtime startup through final proof: 349.153s; do not present the resumed runtime as including all initial setup/coding.
- Complete-tree approval: 21:05:16.802; both Git pushes complete: 21:05:17.068; signed/tested candidates ready: 21:05:30.055 UTC.
- Real review posted/attested: 21:07:53.649; final publication proof: 21:07:59.837 UTC.
- Reviewer's independent-check rerun: 21:09:21.447994–21:09:25.922168 UTC. It is explicitly labeled a later confirmation, not a preserved original log.
- Existing Decision.at uses the selected native State's created_at (21:05:18), not decision wall-clock time. Use the explicit orchestration timeline and publication checkedAt for action timing.
- Provider labels identify OpenAI native collaboration. The runtime did not expose an exact model; runtime-selected-not-exposed is an unknown-model marker. Actual task identities and mapping to synthetic Git/Heddle identities are in native-agent-provenance.json and the signed review. No Claude identity was fabricated.

## Runtime and remaining limits

Stock Heddle 0.30.0 from commit 878fea434d2eed86865c0daf3f3b1ab7da6d2e4f; Git 2.47.3; Node 24.19.0; Wrangler 4.149.0. Exact binary digest is in versions.json.

Real local workerd SQLite/R2 and stock Heddle were exercised. Artifacts remains a local smart-HTTP fixture; the engine runs as a host process, not a deployed Container. The reviewer was a genuine native task, not Workers AI. Keys are custodial. Provider labels are declared provenance rather than provider attestations. The choice is a scripted test input, not the user's real decision. Dependency metadata review is not a transitive source/security audit. No live cloud resources, external publication or browser recording are established by this pass. Services stopped cleanly; persisted private state is excluded from this deliverable.

## Safe deliverables

Only the explicit safe-export-allowlist.json files are exportable. Private runtime state, .git/ directories, ha-auth/ha.json, token-bearing Wrangler logs, process environments and keys are excluded. Public verification runs with: node dev/verify-genuine-evidence.mjs <evidence-directory>. The original reviewer check script intentionally preserves its observed absolute evidence path; change only that root location to rerun it on a copied evidence directory.
