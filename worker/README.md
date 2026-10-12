<!-- SPDX-License-Identifier: Apache-2.0 -->
# Track A control plane

`contracts/` is §7 and was published first in PR #1. Track A's ongoing draft is
PR #5. The production Worker imports Track D's `createReviewer(env)` through
Wrangler's `heddle-reviewer` alias. Local mode resolves the same import to the
explicit reviewer fixture; no Workers AI credentials are used locally.

Run local checks from the repository root:

```sh
npm ci
TMPDIR=/home/scratch WRANGLER_LOG_PATH=/tmp/heddle-wrangler.log npm test
npm run typecheck
TMPDIR=/home/scratch npm run test:negative
TMPDIR=/home/scratch npm run test:local-flow
TMPDIR=/home/scratch bash scripts/smoke-artifacts.sh --fake
```

`test:negative` temporarily breaks each A-T1–A-T5 production guard, requires a
nonzero test exit and an assertion failure, restores each original file in a
`finally` block, then requires the restored suite to pass. Run it alone, since
it deliberately changes source files briefly. `test:local-flow` runs real
Wrangler, Git smart HTTP, SQLite and R2, with explicitly labelled engine and
reviewer fixtures. It creates and removes its own temporary directories and
processes. It does **not** claim real Heddle projection evidence.

For interactive local development, put a local operator token in `.dev.vars`
(the file is gitignored), then run these in three terminals:

```sh
TMPDIR=/home/scratch npm run dev:artifacts
TMPDIR=/home/scratch ENGINE_STUB=1 npm run dev:engine
WRANGLER_LOG_PATH=/tmp/heddle-wrangler.log npm run dev
```

The default ports are Worker 8787, fake-artifacts 8788, engine-devserver 8789.
The dev config sets `DEV=1` and avoids all remote Cloudflare bindings. A local
push hook posts to `/__dev/events`; the 3-second alarm also polls active forks.
That route returns 404 in production. Tokens appear only in authenticated
responses and agent Git header configuration. The coordinator persists only
agent-key SHA-256 hashes, their expiry, and a non-secret Artifacts credential
ledger. A project has a fixed one-hour demo lifetime by default;
`DEMO_CREDENTIAL_TTL_SECONDS` accepts integer seconds from 120 through 3600,
with a hard one-hour ceiling. Refresh and re-enrollment never extend that
project deadline. The two-minute configuration minimum leaves room for initialization above the
provider minimum. Token issuance still stops when fewer than 60 provider-TTL
seconds remain after its one-second safety margin; it never extends the project
deadline to finish initialization or refresh. Transient engine tokens last at most 10 minutes (and never
past the project deadline) and are revoked after execution. Both canonical and fork read
tokens are included so publishing can inspect remote notes safely. Re-enrollment is idempotent
for identity, fork and lane; it rotates the agent key and fork token, so callers
must use the returned credentials. A refresh requires one active lane for the
agent, because §7's refresh path has no task selector.

Once Track B and D are available, use the real engine:

```sh
TMPDIR=/home/scratch \
HEDDLE_BIN=/home/scratch/heddle-0.30-bin/bin/heddle \
ENGINE_SCRIPT="$PWD/engine/engine.mjs" \
ENGINE_DEMO_SEED="$PWD/demo/seed-project" \
npm run test:real-flow
```

The script checks F1–F5, original candidate SHAs, landed tree equality, notes
and a fresh-clone `git fsck --strict`. `ENGINE_SCRIPT` can also point at a
read-only Track B checkout during integration. The host server gives each
project a separate `ENGINE_STATE_DIR`; no state or credentials go into the
engine image. The real engine uses the stock Heddle 0.30.0 CLI at `878fea43`.
The development reviewer stays a fixture until the production alias is used.

The SQLite tables are `agents`, `lanes`, `tasks`, `candidates`, `turns`,
`decisions`, `pushes`, `ops`, `credentials`, and `meta`. A separate ProjectDO instance named
`__routing__` stores fork-to-project routing, including hashed long fork names.
All engine commands for a project share one queue. A mutating request is
journaled before exec, restores the committed R2 generation on retry, streams
its snapshot through bounded multipart uploads, and commits its result,
metadata and generation together. Failed engine commands have three attempts;
domain rejections are not retried. A pending journal entry replays after DO
and engine disk loss. Decisions resume publication after a crash. After three failed publication
attempts, reads remain available and repeating the same operator decision
resumes publication without a second native decision. Losing
fork tokens are revoked. Heddle lease release belongs to engine `decide`, since
§7 defines no separate release command.

Before live integration, set `CF_ACCOUNT_ID` and `EVENTS_QUEUE_ID` as Worker
variables, and install `OPERATOR_TOKEN` and `CF_EVENTS_API_TOKEN` as secrets
outside the sandbox. `wrangler.jsonc` binds Artifacts, ProjectDO, HeddleEngine,
Queue, R2, AI and Track C assets. Its engine image and reviewer alias become
available when the corresponding track PRs land. Run A-S1 outside the sandbox
and record the result in `docs/SMOKE.md`; the script uses a temporary HTTP-pull
Queue so its event latency is observable without racing the deployed consumer.
Subscription errors select R3 poll-only mode automatically and are stored on
the lane. Notes rejection selects the architecture's R1 engine fallback.

Long fork names use `full.slice(0, 46) + "-" + SHA256(full).slice(0, 16)`,
where `full` is `project--task--agent`. Track B must use the same name when
validating a lane remote; the current integration flow uses short names.

Source API shapes were checked against Cloudflare's
[Artifacts binding](https://developers.cloudflare.com/artifacts/api/workers-binding/),
[event schemas](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/),
and [container exec](https://developers.cloudflare.com/containers/guides/execute-commands/) docs.

## Local demo credential closure

This hardening is local source work and is not evidence of deployment or live
credential creation. All explicit canonical reads, fork writes, and engine
leases pass through one durable receipt ledger before their bearer is returned
or used. Receipts contain IDs, repositories, owners, type, expiry, and revocation
state only. Tracking failures immediately attempt compensating revocation; a
separate non-secret durable debt record allows retry if the SQL receipt write
failed. If all durable writes are unavailable, the earlier unknown issuance
receipt remains unresolved rather than claiming a complete inventory.

The operator-only `GET /api/projects/:id/credentials` (also
`/credentials/status`) returns bounded, non-secret status. The operator-only
`POST /api/projects/:id/cleanup` permanently closes this demo project before
revoking up to 100 known credential IDs per call. It invalidates every agent HTTP
key, closes feeds, and fences token refresh, engine mutation, pending replay,
push ingestion, and background review/poll work. Repeated cleanup calls and
alarms retry known-ID revocation debt. HTTP 202 and `complete: false` mean work
or uncertainty remains. HTTP 200 with `complete: true` applies only to the
reported app-issued Git and agent HTTP credentials. An `expiredFallback` count
explicitly distinguishes presumed provider expiry from confirmed revocation;
that fallback depends on the provider enforcing its returned expiry.

A createToken request with a lost response or process interruption has no known
provider ID or guaranteed completion time: it remains unknown without an
invented expiry. Repository/fork creation can similarly return a bootstrap
bearer with no ID or expiry. That bearer is revoked immediately in memory and
never stored. If the response or revocation is uncertain, status retains that
uncertainty, blocks ordinary work, and cannot claim complete cleanup. Reusing an
already-existing repository is recorded as an unknown historical inventory;
cleanup revokes only IDs issued by this coordinator, never unrelated tokens.
Legacy project metadata without a bounded lifetime is closed, old agent hashes
without valid expiry are denied, and recoverable legacy fork IDs are tracked
for revocation without inventing expiry information.

Cleanup never deletes Git repositories, R2 snapshots, native proof, public keys,
or custodial native signing keys. Those retained native keys are not HTTP/Git
access grants, and the closed coordinator cannot use them for new mutations.
Operator proof views remain readable. The configured public demo `/why/:sha`
view remains read-only and does not trigger engine mutation/recovery. Cleanup
fences new work and late responses; it cannot roll back a native command or Git
publication that was already executing. Retained snapshots/proof describe the
last committed coordinator state and do not guarantee that an interrupted
operation completed. Existing
agent feeds recheck their bound key hash and expiry on event delivery, ping,
and alarms, including after hibernation. Project expiry/cleanup closes every
feed; late authenticated responses are rechecked before returning.
