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
The caller must serialize operations per project, as ProjectDO specifies.

`/state` contains `repo/`, `lanes/<task>/<agent>/`, `agents/<id>/home/`,
`export.git`, `ops.jsonl`, the manifest and collaboration attestations.
Snapshots include the keys and native history; they belong in private R2.
They exclude `node_modules`. Restore moves checkout pointers and clears copied
local discovery bindings before the stock CLI rediscovers the repository.
After a failed or interrupted mutation, restore the last committed snapshot
before replaying the ProjectDO journal; an uncommitted partial operation is
not automatically repaired in place.

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

`ingest` fetches each independent fork once per batch, captures sequentially,
deduplicates `(lane, sha)` even within one batch, and pushes the original
candidate SHAs. Tests run `npm test --silent` inside the lane. A lockfile with
missing dependencies triggers `npm ci --ignore-scripts`; installation and
tests share the 60-second budget. Test output is bounded and contains no
Artifacts authentication environment. Registry access is needed for the first
locked installation; subsequent installations reuse a temporary npm cache.

`publish` checks the fork tips, original candidate refs, restored export SHA,
selected tree and strict Git object integrity before pushing. It writes prose
to `refs/notes/heddle-why` and preserves the native machine-note tree. Notes
commits are parented on the remote tips for ordinary fast-forward pushes.
Candidate updates also use fast-forward pushes. After another task lands,
merge upstream main into a still-open fork before selecting it; an old base
is rejected before changing native history.

Run all acceptance tests, including temporary production-code mutations:

```sh
HEDDLE_BIN=/home/scratch/heddle-0.30-bin/bin/heddle TMPDIR=/home/scratch bash engine/test/e2e.sh
TMPDIR=/home/scratch node engine/test/vitest.mjs
TMPDIR=/home/scratch DOCKER_CONFIG=/home/scratch/track-b-docker-config node engine/test/docker.mjs
docker run --rm -e HEDDLE_BIN=/usr/local/bin/heddle --entrypoint bash heddle-artifacts-engine:track-b /opt/engine/test/e2e.sh
```

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

Integration still needs Track A's real-account notes/ref smoke and Track D's
actual `demo/seed-project`. If notes are rejected, activate §9 R1's branch
fallback before deployment. Long truncated fork names must use Track A's
agreed hash algorithm. The temporary `types.ts` is the exact §7.1 copy, marked
`TODO: switch to contracts/`; remove it after the contracts PR reaches main.
