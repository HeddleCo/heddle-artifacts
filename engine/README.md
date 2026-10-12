<!-- SPDX-License-Identifier: Apache-2.0 -->
# Track B engine

The engine runs the published Heddle 0.30.0 CLI at `878fea43`, without changes
in the Heddle repository. Build from the repository root:

```sh
DOCKER_CONFIG=/home/scratch/track-b-docker-config docker build -f engine/Dockerfile -t heddle-artifacts-engine:track-b .
printf '{}\n' | docker run --rm -i heddle-artifacts-engine:track-b selftest
```

For host development, set `HEDDLE_BIN` to the pinned CLI and
`ENGINE_STATE_DIR` to a private writable directory, then invoke
`node engine/engine.mjs <command>` with the §7.3 request on stdin.
`ARTIFACTS_READ_TOKENS` and `ARTIFACTS_WRITE_TOKEN` are transient environment
variables. Do not put credentials in remote URLs.

All fourteen commands implement §7.3 in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). JSON requests produce one
JSON line: exit 0 for success, 2 for domain rejection, 1 for a crash.
`snapshot` produces a tar.zst stream; `restore` consumes that stream and
returns its generation. A mutating request requires `opId`; a committed replay
returns the recorded result without another capture or generation increment.
Replay is bound to the command and a SHA-256 digest of its canonical JSON input;
changed values reject with `op_id_conflict`, while reordered object keys replay.
Legacy operation records without a request digest also fail closed on replay.
The caller must serialize operations per project, as ProjectDO specifies.

`/state` contains `repo/`, `lanes/<task>/<agent>/`, `agents/<id>/home/`,
`export.git`, `ops.jsonl`, the manifest and collaboration attestations.
Snapshots include the keys and native history; they belong in private R2.
They exclude `node_modules`. Restore moves checkout pointers and clears copied
local discovery bindings before the stock CLI rediscovers the repository.
After a failed or interrupted mutation, restore the last committed snapshot
before replaying the ProjectDO journal. Publication additionally checkpoints its
exact prepared receipt before remote writes, so the same publication can resume
in place after a process restart. Other mutations are fenced while that local
checkpoint is pending. Snapshot restore recovers an already-staged publication
from the remote directory even when the checkpoint was not in that snapshot.

Each enrolled identity has a mode-0600 `device-identity.toml`. Captures require
the native writer lease token and are independently verified against Heddle's
stored Ed25519 attachment and recomputed content hash. Expired leases are
reserved again for the registered active lane; invalid tokens fail closed.
Git author fields do not select the Heddle identity. Keys are **custodial**:
the engine holds them; agents use only their Artifacts fork tokens.

The pinned CLI's local discussion envelopes are unsigned. The adapter signs
their exact native MessagePack bytes with the enrolled reviewer or human key.
Why notes include the public key, signed payload and signature, including a
decision proof binding the native resolution envelope, selected and landed
States, and Git SHA. `lib/attestations.mjs` verifies these portable proofs.

[`GATES.md`](GATES.md) records G1 and the named G2/G3 fallbacks. G2 uses native
lanes, Git conflict previews, and absorption of the chosen lane. Its
`resolutionState` anchors the selected agent State. G3 performs the native
land, exports its tree and untouched machine notes, then creates a fixed
Git landing commit with the native State/Change footers. Persisted parent,
identity, date and message make publication reproducible after restore.
The stock machine notes remain attached to stock-native exported commits;
the fixed fallback main does not itself receive a remapped machine note.
Its native State/Change trailers and `heddle-why` decision proof connect it
to the native history without modifying the stock machine-note tree.

`ingest` fetches each independent fork once per batch, captures sequentially,
deduplicates `(lane, sha)` even within one batch, and pushes the original
candidate SHAs. Before any npm process, `lib/trusted-tests.mjs` requires the
complete source tree to match the operator-reviewed SHA-256 manifest in
`demo/trusted-test-trees.json`. The shipped manifest covers only the public
synthetic seed and scripted Alice, Bob and Carol trees. Unknown trees remain
signed native candidates with `tests.status: "skipped"` and a `Tests withheld:`
reason; they never run install or test scripts.

The guard includes hidden/untracked files, directories, executable modes,
scripts, configuration and lockfiles. It rejects symlinks, hardlinked files,
unsafe paths or modes, candidate `node_modules`, `.git` and `.npmrc`. Only the
root native `.heddle` directory is excluded: `materialize()` already rejects
incoming metadata paths, and this directory is never read or copied for tests.
Verified bytes are copied into a fresh private temporary directory, so source
changes after verification cannot change the executed files.

Tests run `npm test --silent` in that verified copy. Each run installs its own
dependencies with `npm ci --ignore-scripts`; installation and tests share the
60-second budget, and output is capped at 1 MiB. npm receives empty isolated
user/global configuration, private HOME/TMPDIR and no Artifacts credentials.
An operator-owned, non-symlink `$TMPDIR/heddle-npm-cache` outside candidate and
engine state can be prewarmed; npm checks cached packages against the reviewed
lockfile integrity. Otherwise registry access is needed within the time budget.

This is a narrow **reviewed-fixture gate, not a sandbox**. Approved fixtures and
their locked dependencies still run with the engine UID. Do not add unreviewed
agent output to the manifest or use this to claim arbitrary-code isolation.
Genuine new code needs a separate source/dependency review or an isolated runner.

An operator may set `HEDDLE_TRUSTED_TEST_MANIFEST` to an absolute regular file
outside candidate checkouts and `ENGINE_STATE_DIR`. The file and its parent
directories must have trusted ownership and safe permissions; symlink and
hardlink aliases fail closed. This is never accepted from an ingest request,
and there is no boolean execution bypass. Tests use separate explicit reviewed
synthetic manifests; they do not enroll arbitrary candidate trees on the fly.
To check the shipped artifact, run `node scripts/generate-trusted-test-trees.mjs`.
Only after reviewing all fixture source and dependency changes, explicitly run
the same script with `--write` and review the resulting manifest diff.

`decide` freezes a deep publication input: exact ingested candidates, enrolled
public identities, discussion/proofs, rationale, and the native machine-note
commit. Later fork pushes, comments, or identity metadata cannot rewrite that
snapshot. The engine retains those objects under local-only refs. Historical
snapshots without a frozen decision input fail closed with
`publication_input_missing`; publication does not invent replacement evidence.

`publish` checks original ingested candidate refs, restored export SHA,
selected tree and strict Git object integrity. It uses **recoverable ordered
publication**, supported by ordinary Git servers with atomic push disabled:

1. Prepare exact notes and candidate OIDs, with expected-old ref values. Preserve
   already-landed main rationale byte-for-byte. The native machine-note tree is
   preserved; its wrapper commit can be parented on the prior notes snapshot.
2. Create a deterministic directory commit at `refs/heads/heddle/agents` with
   `.heddle-agents.json` and `.heddle-publication.json`. The manifest binds main,
   its expected parent, a hash of decision-time input, and exact auxiliary OIDs.
   Its first parent is the previous directory (or a fixed empty root); other
   parents retain all proof/candidate/main objects. Save a local checkpoint and
   the canonical request hash before the first remote write.
3. Stage that directory first, then auxiliary refs, using explicit expected-old
   leases and checked fast-forward ancestry. Read back every exact OID.
4. Advance main last with an explicit expected-parent lease, then read back main
   and every exact auxiliary ref before reporting success.

This is **not an all-refs-atomic transaction**. Failed staging may expose pending
notes, candidate refs, or a directory while main remains unchanged. Readers must
select the immutable manifest whose `main` matches the main they are inspecting,
using directory first-parent history (`resolvePublication` in `lib/publish.mjs`),
rather than treating current auxiliary aliases as a completed publication.
A later pending publication does not replace the earlier main's immutable proof.
The directory keeps one manifest per main; duplicate or changed snapshots reject.

Lost acknowledgement and snapshot replay use the same immutable directory
commit, reconstructed against its original baselines. If main already matches,
recovery only verifies retained proofs and never rewrites remote notes or other
aliases. A different main or modified pending refs fails closed; the engine does
not roll back auxiliary refs or adopt unrelated remote changes. The existing
per-project single-writer requirement still applies. External writers can always
change refs after a readback; this protocol detects such conflicts and does not
claim cross-ref isolation against an administrator force-pushing or deleting refs.

A changed request using an interrupted publication's `opId` is rejected under the
same canonical request binding as completed operations. A new retry `opId` may
resume the identical decision snapshot. Completed operation replays still return
the recorded result without remote mutation. The output `pushed` list names the
transaction refs; a recovery may verify earlier writes without issuing a push.
If a new-op replay sees the same
publication directory but a changed compatibility alias, it rejects that alias
conflict without invalidating or rewriting the retained decision. In particular,
a later legitimate ingest on an open lane can move its candidate alias; use that
lane's subsequent decision/publication rather than republishing an older snapshot
under a new operation ID. A newer pending directory is handled separately through
the historical manifest resolver.

Candidate updates also use fast-forward pushes. After another task lands,
merge upstream main into a still-open fork before selecting it; an old base
is rejected before changing native history.

Run all acceptance tests, including temporary production-code mutations:

```sh
HEDDLE_BIN=/home/scratch/heddle-0.30-bin/bin/heddle TMPDIR=/home/scratch bash engine/test/e2e.sh
HEDDLE_BIN=/home/scratch/heddle-0.30-bin/bin/heddle TMPDIR=/home/scratch node engine/test/hardening.mjs
TMPDIR=/home/scratch node engine/test/vitest.mjs
TMPDIR=/home/scratch DOCKER_CONFIG=/home/scratch/track-b-docker-config node engine/test/docker.mjs
docker run --rm -e HEDDLE_BIN=/usr/local/bin/heddle --entrypoint bash heddle-artifacts-engine:track-b /opt/engine/test/e2e.sh
```

The aggregate begins with `node --test engine/test/trusted-tests.mjs`. It proves
that a malicious test cannot run npm, read or overwrite a synthetic engine-state
sentinel, or self-authorize with a candidate-provided manifest. It also checks
symlink/hardlink, lockfile, mode, ignored-file, npm-config and dependency-tree
rejections. The native e2e then proves that withheld execution still produces a
signed native candidate. `vitest.mjs` checks separately reviewed positive and
negative test outcomes, plus refusal of an unreviewed test change.

The mutation suite copies only `engine/` into temporary directories. It leaves
tracked sources intact and asserts that each disabled check breaks the same
acceptance assertions. The Docker test also proves the size check fails when
the full Debian runtime replaces the minimal Debian filesystem, and the
version check fails when Git is substituted for Heddle. Exact outputs are in
[`EVIDENCE.md`](EVIDENCE.md).

The Docker build uses the required cached multi-stage `cargo install --locked
--git https://github.com/HeddleCo/heddle --rev 878fea43 heddle-cli`, generates
and checks the binary SHA-256 between stages, and runs as UID/GID 65532. It
copies the required tools and shared libraries from Debian trixie into a
minimal root filesystem to stay below 400 MB. No release tag or binary asset
is required.

Real-account smoke has confirmed ordinary main/candidate/notes pushes and
reported that atomic push is unsupported. The ordered protocol still needs its
separately approved real-account capability probe; local bare-Git proof is not
production acceptance. If notes are rejected, activate §9 R1's branch fallback
before deployment.
Long fork names use Track A's 46-character prefix plus a hyphen and 16
hexadecimal SHA-256 characters, keeping the name within 63 characters.
Candidate, Turn and Decision annotations consume
`contracts/types.ts`; contract validation consumes `contracts/engine.schema.json`.
Track A's contracts have been merged from main and the temporary types copy
has been removed.
