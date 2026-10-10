<!-- SPDX-License-Identifier: Apache-2.0 -->
# Track B engine

The engine runs the published Heddle 0.30.0 CLI at `878fea43`, without changes
in the Heddle repository. Build from the repository root:

```sh
DOCKER_CONFIG=/home/scratch/track-b-docker-config docker build -f engine/Dockerfile -t heddle-artifacts-engine .
printf '{}\n' | docker run --rm -i heddle-artifacts-engine selftest
```

For host development, set `HEDDLE_BIN` to the pinned CLI and
`ENGINE_STATE_DIR` to a private writable directory, then invoke
`node engine/engine.mjs <command>` with the §7.3 request on stdin.
`ARTIFACTS_READ_TOKENS` and `ARTIFACTS_WRITE_TOKEN` are transient environment
variables. Do not put credentials in remote URLs.

The draft implementation is being built against §7 in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). Gate evidence will live in
`GATES.md`; the standalone acceptance command is `bash engine/test/e2e.sh`.
The temporary `types.ts` is the exact §7.1 copy, pending Track A's contracts.
