<!-- SPDX-License-Identifier: Apache-2.0 -->
# Eight-minute take

Record at 1280×720 with a readable font; keep the board and terminal visible.
Use three independent forks, Alice/Bob on `parser-escapes`, Carol on `docs-readme`.
A scripted run is the guaranteed R7 fallback. Live mode is the preferred take
only after an actual concurrent live rehearsal produces the parser conflict.
Never show environment variables, enrollment response JSON, Git config, auth
files, browser operator token or setup scripts with headers. Revoke recording
tokens after the take through the platform operator's cleanup command.

| Time | Shot/action | Narration |
| --- | --- | --- |
| 0:00–0:45 | Show two competing `parseRow` edits. | “Agents work at once. A branch fight should not erase an alternative or its reasoning.” |
| 0:45–1:45 | Run project creation/enrollment, show board and `ha join` success. | “Cloudflare Workers coordinates the project. Each agent gets its own Artifacts fork and a repo-scoped write token.” |
| 1:45–3:15 | Three tmux panes in live mode, or scripted push output; board pulses. | “These are ordinary Git pushes directly to Artifacts. Heddle is off the transport path; candidates appear asynchronously.” |
| 3:15–4:45 | Compare Alice/Bob diffs and tests. Show Carol's separate clean task. | “Both changed parseRow. Alice’s regex is short but misses slash parity and trailing escapes. Bob keeps the string-array API and passes all 18 tests. Each alternative retains its original SHA and agent attribution.” |
| 4:45–6:00 | Reviewer card plus Luke's reply. | “Workers AI recommends from task intent, diffs and tests. A separate engine-held reviewer key signs its discussion turn. The human can agree or disagree.” |
| 6:00–7:00 | Show Bob selection and required rationale; press Land. | “The decision cites the current heads. A stale view fails closed. Heddle records the resolution and landing.” |
| 7:00–8:00 | Fresh clone, Git notes, remote alternatives, tree equality and strict validation. | “The losing alternative remains addressable. The chosen content and the decision travel inside plain Git. Artifacts holds the Git. Heddle holds the decisions.” |

## Terminal proof

The harness creates a fresh `proof` clone under `<DEMO_DIR>/<generation>/proof`.
Keep that checkout for the separate terminal shot.

Use the CLI's trusted remotes without putting a bearer on the command line:

```sh
# Run inside Bob's enrolled clone. It already has a scoped read header.
git fetch upstream main 'refs/heads/candidates/*:refs/remotes/upstream/candidates/*' '+refs/notes/*:refs/notes/*'
git log --notes='heddle*' -1 upstream/main
git branch -r
git rev-parse 'upstream/main^{tree}' 'upstream/candidates/parser-escapes/bob^{tree}'
git fsck --strict
```

For a genuinely fresh clone, use the harness `proof` checkout; do not replay a
manual `git clone` with a token in its URL. In that checkout:

```sh
git log --notes='heddle*' -1 main
git branch -r
git rev-parse 'main^{tree}' 'origin/candidates/parser-escapes/bob^{tree}'
git fsck --strict
git repack -ad
for pack in .git/objects/pack/*.pack; do git index-pack --strict "$pack"; done
```

Say “fixture keys / local API mock” explicitly if showing local contract tests.
Use the real deployment/engine for the competition take. The reviewer fallback
must remain labeled `model:"fallback"`; if it activates, narrate human review.
Show Track B's restore-and-export round-trip output separately: plain Git tree
checks do not prove Heddle projection reproducibility. If A-S1 rejects notes, use
§9 R1's `heddle/why` branch and update the proof commands before recording.

## Rehearsal evidence to attach

- D-T1: two deployed scripted takes after reset, each <240 s, `result.json` plus terminal output.
- D-T2: reviewer fixture/fallback tests and mutations in `demo/evidence/`.
- D-T3: clean-container README transcript, <600 s, reaching Git notes.
- D-T4: real coding agents in three panes, push timestamps overlapping, compare showing `parseRow` conflict, video path supplied by owner.
