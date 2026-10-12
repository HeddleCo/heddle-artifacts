<!-- SPDX-License-Identifier: Apache-2.0 -->
# Decision timestamp fix: independent review and historical-candidate replay

PASS, 2026-10-10 UTC. This is a distinctly labeled replay of the original genuine native-agent commits and exact historical reviewer text. No new coding session, fresh review model invocation, cloud resource or external publication occurred.

## Independent source review

The two production changes in engine/lib/commands.mjs are appropriate: Decision.at and state.projection.at both use decisionTurn.at. The existing discuss operation derives that timestamp from the native rationale operation's occurred_at_ms. A fast-forward keeps the earlier candidate State, so landed.created_at was not the decision event time. Using one persisted native event timestamp fixes chronology while retaining deterministic projection/export. Existing decisions are not rewritten by this patch.

The new engine/test/e2e.mjs assertions check the retained native rationale turn, identical projection pin, ordering after review, and timestamp preservation after restore. No blocking issue found in the narrow fix. The parent owns the complete e2e test result; this report independently establishes the replay checks below.

## Exact reused inputs and fresh local output

- Original scanner commit: 167c9385e04e1b9028588f6534b51c5e1c398494.
- Original parity commit: 299f09558f9bb50b99127c122dcaa827a98752c1.
- Reviewer JSON is byte-for-byte historical input from genuine-native-v1. Its earlier review timestamps intentionally remain unchanged inside that reused body.
- Fresh local runtime: 35.813 seconds, including re-ingestion, signed historical-review repost, scripted replay choice and fresh-clone proof. This does not include or claim new coding/review work.
- New canonical landing: 37c8e617aedbdce0fc33a42a6ba3b42148149c67.
- Same selected tree: 01ee577e5987a2329d46390960abfcbdecb773cb.
- Replayed review operation: 2026-10-10T21:14:12.673Z.
- Authentic native rationale operation / Decision.at / projection pin: 2026-10-10T21:14:15.737Z.
- Recorded publication verification: 2026-10-10T21:14:18.641Z.
- Git commit epoch: 1791666855, exactly the native decision time truncated to Git's whole-second precision.

Decision.at names the native rationale event, not publication completion; those times are separately recorded.

## Independently verified

- Exact original candidate commit OIDs and tree OIDs preserved in the fresh canonical candidate refs.
- Scanner 56/56 and parity 70/70 tests passed again under the unchanged out-of-band reviewed-tree manifest.
- Both overlapping candidate conflicts, custody-verified native captures and historical review provenance retained.
- Public replay-context discussion and rationale explicitly state that no new coding or reviewer session occurred.
- Fresh clone, chosen tree equality, explicit notes fetch, strict fsck/index-pack, chosen/rejected why narrative and native State/Change trailers passed.
- SHA-bound exportRoundTrip/treeMatch/fsck publication checks passed.
- Five exported Ed25519 native-envelope attestations independently verified, including exact historical review bytes and public keys from the published directory.
- Two direct exports and two exports after fresh snapshot restore reproduced the same landing SHA. The original state directory was unavailable during restored exports. Repeating this postcheck also passed without changing the pinned time or SHA.
- Historical genuine-native-v1 file checksums and original archive SHA remain unchanged: f979c969faf68f3418207562166e4f0119f040f9d077adfae54da914bfe7a6dc.

## Scope and delivery

Real local Wrangler/workerd SQLite/R2 and stock Heddle 0.30.0; local fake Artifacts smart HTTP; host engine rather than deployed Container. Captures and native-envelope attestations use custodial keys. The native reviewer text was historically genuine and is only replayed here. The decision remains an explicit scripted test choice.

Only safe-export-allowlist.json files belong in the public packet. Raw snapshot, restored state, key material, private runtime and fork Git authentication are excluded. Original candidate source and original independent-review confirmation remain in the separate immutable genuine-native-v1 packet.
