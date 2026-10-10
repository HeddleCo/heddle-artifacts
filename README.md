<!-- SPDX-License-Identifier: Apache-2.0 -->
# heddle-artifacts

Heddle on Cloudflare Artifacts. A Git platform where many agents work on one codebase at the same time:

- Each agent pushes plain `git` to its own Artifacts fork.
- Overlapping work becomes **comparable candidates**, not rejected pushes.
- Every landing on `main` carries its **why** (intent, alternatives, review, decision) in `refs/notes/heddle-why`, with Heddle’s machine-note ref retained separately. The fixed landing commit carries native State/Change trailers; its why note is attached directly.

Status: under construction for Cloudflare's "Build the next Git platform" competition. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Licensed under Apache-2.0.

For the account-free integrated rehearsal, see [Run locally](docs/LOCAL-INTEGRATION.md).
Live compatibility evidence is tracked in [the A-S1 report](docs/LIVE-ARTIFACTS-20261010.md).
Artifacts rejected atomic push; the current engine uses a verified, recoverable
main-last protocol. Auxiliary refs may be pending and are not a joint atomic view.

## Try it

Requires Node 22+ and Git; the operator supplies an HTTPS Worker URL and an
operator token for the demo project. No Heddle install is needed. For a private
checkout, authenticate GitHub before cloning; the competition release will be
public. Keys used by Heddle are custodial: the engine holds one signing key per
agent/human/reviewer; Git author fields alone are not trusted identities. Candidate test execution is restricted to an out-of-band reviewed whole-tree allowlist. Unknown code is withheld, not executed in the custodial engine.

```sh
git clone https://github.com/HeddleCo/heddle-artifacts.git
cd heddle-artifacts
# Load OPERATOR_TOKEN securely in this shell. Do not paste it into a URL or video.
export DEMO_URL=https://your-worker.workers.dev
export DEMO_PROJECT=demo
export DEMO_DIR=/tmp/heddle-try-it
./demo/run.sh --mode scripted
```

The last command creates two tasks, enrolls three agents in independent forks,
pushes their prepared commits concurrently, waits for conflict candidates and a
signed review, records a clearly scripted discussion and decision under the demo human identity, then prints
`git log --notes='heddle*'` from a fresh clone. It fails if candidate SHAs change,
the chosen tree differs, Git objects fail strict validation, the decision is
stale, or the chosen/rejected notes disappear. See [demo/README.md](demo/README.md)
for reset, live mode and local testing. A second take requires the cleanup
command from the operator because the §7.2 API has no project-delete route.

Join the existing docs task in your own clone:

```sh
HA="$PWD/cli/ha.mjs"
node "$HA" join "$DEMO_URL/p/$DEMO_PROJECT" --task docs-readme --as guest --dir /tmp/heddle-guest
cd /tmp/heddle-guest
node "$HA" status
git fetch upstream main '+refs/notes/*:refs/notes/*'
git log --notes='heddle*' -1 upstream/main
node "$HA" why "$(git rev-parse upstream/main)"
# Make your own documentation edit, then commit and git push origin HEAD:main.
```

Bearer headers are scoped to the fork and canonical URLs, stored in private
`.git` files, never embedded in remote URLs. Do not print Git config on camera.
Prepared parser candidates have 18 tests: Bob passes; Alice demonstrates the
edge-case failures. Carol's independent documentation candidate passes the 14
baseline tests. [demo/RECORDING-CHECKLIST.md](demo/RECORDING-CHECKLIST.md) is the
current seven-minute acceptance checklist; `demo/VIDEO.md` retains the earlier shot list.
