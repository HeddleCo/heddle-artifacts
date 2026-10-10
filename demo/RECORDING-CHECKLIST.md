<!-- SPDX-License-Identifier: Apache-2.0 -->
# Seven-minute competition take

Use this only after the live acceptance gates pass. The saved 62-second local
storyline uses fake Artifacts, a stub reviewer and a scripted choice; it is a
rehearsal, not the competition take. Keep those labels if showing it.

## Before recording

- Confirm the permitted account, namespace residency, temporary resources,
  credential lifetime, cost exposure and cleanup owner.
- Pass actual Artifacts candidate/notes refs, the reviewed recoverable main-last
  publication protocol, exact clone/readback and Queue delivery. A2 rejected
  atomic push; unchecked separate pushes are not an acceptable substitute.
  Show auxiliary refs as pending until main's immutable snapshot is established.
- Build and run the exact engine image, then prove deployed Container/R2 restore
  and stable fixed projection after an interruption.
- Verify the real reviewer response and its provider/model label. If it falls
  back, say so; a native signature authenticates the recorded author, not the
  quality of model output.
- Run at least two genuine coding agents concurrently and retain their start/end
  timestamps, original pushed SHAs and native Capture signatures. Do not present
  prepared scripted clients as fresh agent work.
- Review complete candidate code/dependencies outside candidate control before
  approving its trusted test manifest. Unknown trees must remain withheld. This
  gate is not a sandbox; a review pause is part of the current demo workflow.
- Ask the human to make the choice and enter their own reason. The automated
  test's prewritten choice must not be presented as a live human decision.
- Verify public runnable source and its Apache-2.0 license are actually available.
  Publishing the repository and submitting the entry require owner approval.
- Open the board, comparison and fresh-clone terminals at readable sizes. Check
  keyboard navigation, pending publication, retry and exact-SHA proof display.

## Shot list

| Time | Show | Claim supported by the shot |
| --- | --- | --- |
| 0:00–0:30 | The shared task and two competing edits | Agents can keep their alternatives and reasoning. |
| 0:30–1:00 | Small architecture view, real deployment URL | Git goes directly to Artifacts; Workers coordinates the native Heddle engine. |
| 1:00–2:05 | Genuine concurrent agent work and ordinary pushes | Each agent has its own fork; original Git commits remain identifiable. |
| 2:05–3:10 | Compare both diffs, exact SHAs, signatures and test outcomes | Both alternatives survive. Explain the actual overlap preview and approved-test boundary. |
| 3:10–4:10 | Actual reviewer findings and a human reply | The reviewer provides evidence; the human can disagree. Show the real provider/fallback label. |
| 4:10–5:00 | Human picks a candidate, types a reason, lands | The decision binds current candidates; a pending publication is visibly pending until it succeeds. |
| 5:00–6:10 | Fresh clone, explicit notes fetch, candidate refs, tree equality, strict checks | Ordinary Git carries the original alternatives, chosen content and decision narrative. |
| 6:10–6:40 | Retained restore/re-export proof for the same landing SHA | Stock export plus the persisted fixed projection is repeatable after restoration. |
| 6:40–7:00 | Runnable source and the bounded current scope | Close with what works and the source URL, without claiming general multi-tenant hosting. |

Do not narrate Git merge-tree preview/selected-lane absorb as ADR-0053 concurrent
native-head resolution. Original candidate SHA, native State and landing SHA
are different identifiers. Stock machine notes retain their original native
targets; the landing's `heddle-why` note is entry-owned.

## Safe terminal proof

Use the existing scoped Git authentication. Never put tokens in URLs, paste
enrollment JSON, display environment/configuration dumps, or record key files.
Run in the fresh proof clone:

```sh
git fetch origin '+refs/notes/*:refs/notes/*'
git log -1 --format='%h %s%n%b' main
# Show readable narrative; full signed envelopes remain in the fetched notes.
git notes --ref=heddle-why show main \
  | sed -e '/^Turn proof:/d' -e '/^Decision proof:/d'
git branch -r
git rev-parse 'main^{tree}' 'origin/candidates/parser-escapes/<chosen>^{tree}'
git fsck --strict
git repack -ad
for pack in .git/objects/pack/*.pack; do git index-pack --strict "$pack"; done
```

Replace `<chosen>` with the actual human choice. Preserve the original push
SHAs and compare them with the candidate refs. Plain Git tree equality alone
does not prove native restore/re-export: show the separate recorded exact-SHA
verification too.

The unfiltered `git log --notes='heddle*' -1 main` is useful in the retained
evidence, but its complete signed envelopes are too long for a readable camera
shot. Do not remove or rewrite those fields in the stored Git notes.

## After the take

Revoke recording credentials using the approved cleanup flow, remove only the
new temporary resources covered by that approval, and retain the non-secret
result/cleanup ledger. A cleanup failure is a blocker requiring reconciliation.
Do not delete pre-existing account resources or publish the recording without
the relevant owner approval.
