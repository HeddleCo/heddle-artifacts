<!-- SPDX-License-Identifier: Apache-2.0 -->
# A-S1: recoverable main-last smoke (local verified; revised live run gated)

This revision performs local code/test work only. The [earlier A2 exercise](LIVE-ARTIFACTS-20261010.md) accepted
main, fork, candidate refs and notes, but rejected `--atomic`; it did not reach
clone/readback. That result does not establish that the revised flow below works
on the live service. Generate a new version-2 plan and obtain the required approval
before any new live run. A browser login or an old plan is not approval.

## Local evidence

```sh
node --test dev/test/smoke*.test.mjs
bash scripts/smoke-artifacts.sh --fake
bash scripts/smoke-artifacts.sh --fake --prove-ref-check
```

The focused tests cover pure planning, refused targets, a credential-free ledger,
bootstrap and explicit token revocation, ID replacement, ambiguous creates,
cleanup failure, subprocess isolation/timeouts, and the real local Git path.
The local fake explicitly disables atomic capability. `--fake` stages pending
proof refs, verifies exact OIDs and old main, performs expected-old main CAS,
requires a stale CAS rejection, clones a fresh mirror and verifies exact final
refs. It exits 0. The deliberate missing-ref mode exits 1. Separate local tests
prove atomic rejection, rebuilt-notes non-fast-forward rejection, partial staging
and a wrong-hash readback both stopping before main, and refusal to dispatch an
eighth Git network command. These use synthetic repositories and credentials only;
no real authentication path is read.

The smoke reuses production `exactRefs` and `leasedPushArgs` primitives. Its synthetic
manifest has a separate smoke domain and omits full Heddle notes/export proof; it
does not exercise or pass the production manifest resolver. It is a
bounded Git capability probe, not the full engine recovery state machine. Its
single ordinary auxiliary-stage push is distinct from production's directory-first,
then auxiliary-stage sequence. Engine recovery tests independently exercise that
full protocol; local success is not Cloudflare Artifacts acceptance, live Queue
delivery, real repository-history migration, or deployment evidence.

## Seven-command publication and clone probe

Every attempted Git network command consumes one of seven slots, including a
rejected command. There is no retry allowance and an eighth command is refused
before launch. A successful run must consume exactly seven:

1. Seed `refs/heads/main` with the tiny README commit, then create the planned fork
   and mint the already bounded tokens through the control plane.
2. Stage two candidate refs, `refs/notes/heddle-why`, and the existing directory
   namespace `refs/heads/heddle/agents` in one ordinary, non-atomic push. The directory
   contains `.heddle-agents.json` (`[]`) and `.heddle-publication.json`, a synthetic
   format-1 immutable transport fixture with domain `heddle-smoke-transport-v1`,
   pinning main, expected-old main and every proof OID. It is intentionally not
   accepted by the production manifest resolver or full round-trip verifier.
   Its commit retains the referenced proof objects as parents. Candidate/main
   descendants are empty commits; their README trees are unchanged.
3. Read remote refs and require every staged OID and the original main to match
   exactly. A missing, wrong-hash, duplicate or malformed readback fails closed.
4. Publish only main using the production explicit
   `--force-with-lease=refs/heads/main:EXPECTED_OLD_OID` primitive and pinned new OID.
   The new main is a locally verified descendant; no unconditional force is used.
5. Attempt another empty descendant using the deliberately stale expected-old
   value. Only the fixed `git_stale_info` rejection is accepted. Unexpected success
   or a transport/authentication/unknown failure fails the smoke.
6. Make a fresh read-token `git clone --mirror`, run `git fsck --strict`, and check
   exact cloned refs, all four main-history commits, unchanged README trees,
   why-note bytes, empty agent directory and exact synthetic manifest bytes.
7. Read remote refs again and require the exact intended main, both candidates,
   original notes and manifest commit. This confirms the stale probe did not
   advance main. The ledger retains the synthetic manifest and expected hashes.

Auxiliary refs are pending until main CAS and exact readback establish the intended
publication. They can be partially exposed if staging fails. No all-refs-atomic
claim or rollback is made. The smoke fails before main on rejected/uncertain
staging or mismatched proof readback, then cleans only its own recorded resources.
The production immutable manifest is authoritative for its corresponding main,
while ordinary auxiliary aliases may advance for a later pending publication.

## Timing scope and interpretation

Each Git network command emits and retains a fixed phase, monotonic `elapsed_ms`,
outcome, safe failure category when applicable, and `fresh_git_process: true`.
The expected stale CAS remains an explicitly expected failed command, never a
successful-push latency. Failed or timed-out commands are retained as failures.
Control-plane samples separately record fixed operation classes, REST versus
connector-bridge path, method/status/outcome and monotonic duration; bridge timing
includes orchestration. Response size is recorded only when supplied by a valid
Content-Length header, without inspecting or retaining credential-bearing payloads.

The local fixture records exact README/manifest/agent-directory bytes, reachable
Git-object count and total uncompressed object bytes, plus four synthetic main
history commits. These are source/object sizes, not network or compressed transfer
bytes. The mirror destination is fresh and each Git command is a fresh subprocess;
the run records whether launched as its own CLI process. Remote/proxy/OS cache state
is unknown, so this is not a proven cold-service benchmark.

Queue observation requires the exact main-CAS before/after OIDs. A seed-main event
cannot satisfy it. Delay is measured monotonically from main-CAS command start to
local receipt/Queue pull observation, and includes polling plus intervening clone
and readback work for live runs. A canonical bounded service event timestamp is
retained when available and plausible; event-to-observation wall-clock difference
is separate and explicitly does not verify server clock synchronization. Missing or
invalid timestamps do not create invented delivery latency. Total run time includes
cleanup. Samples are kept in the credential-free ledger and sanitized log.

A successful live run would provide one observation on one tiny synthetic fixture.
It cannot establish percentiles, throughput, representative repository clone speed,
latency under concurrency, or a service-level benchmark. No extra remote calls or
repeated runs are added to collect timings.

## Generate an approval plan without network or credentials

```sh
(umask 077; bash scripts/smoke-artifacts.sh --plan --run-id review-20261010 > /tmp/as1-plan.json)
```

`--plan` only computes and prints JSON. It performs no network requests, reads no
credentials, creates no ledger or cloud resources, and makes no account changes.
Shell redirection creates the local plan file. Without supplied verified target
fields it emits `UNVERIFIED`; it does not infer an account or default namespace
from environment variables. Its digest detects edits to the bounded plan, not
user authorization or a cryptographic signature.

For this example the exact resource names are:

- Canonical repository: `as1-review-20261010`
- Fork: `as1-review-20261010--x--y`
- Queue: `as1-review-20261010-events`
- Subscription: `as1-review-20261010-pushed`
- One HTTP pull consumer on that new Queue; its ID is server-assigned

The plan permits at most two repositories, one Queue, one consumer, one
repository-scoped `pushed` subscription, three explicitly minted Git tokens, and
two automatic create/fork tokens. It creates no namespace, Worker, Container,
binding, public endpoint, deployment, API credential, subscription plan or
payment method. It does not import source repositories or upload application code.

Three explicit tokens have TTL **600 seconds**: canonical write, canonical read,
and fork write. Create and fork also return bootstrap write tokens with a
server-selected expiry that this API does not let the script set. The script
lists their IDs on the newly created repository and revokes them immediately,
before explicit minting. The ledger records token IDs/expiry but never plaintext.
Cleanup discovers any remaining tokens only on ID-verified, newly created repos
and revokes them before repo deletion. Do not describe all five tokens as having
a 600-second TTL. If revocation fails, the run fails and requires reconciliation.

Execution bounds: 300 seconds for checks, then a separate 120-second cleanup
budget; 10 seconds per API call; 30 seconds per Git child; 60 seconds for event
observation; at most 160 normal and 60 cleanup API calls. At most 30 Queue pulls
request 20 messages each. A hard budget enforces seven Git network commands. Bounds limit work,
not the lifetime of orphaned cloud resources or the eventual invoice. An expired
plan cannot start; the plan expires one hour after generation.

## Required live approval checklist

All items must be resolved before any live command. The executable flags below
are safety guards, not substitutes for the user's approval.

1. **Account and location:** verify the exact Cloudflare account name and 32-digit
   account ID, existing Workers Paid plan, existing namespace, and namespace
   jurisdiction (`eu`, `us`, or explicitly confirmed unrestricted). The script
   will not create a namespace or change residency. Any Queue residency
   requirement must also be checked before approval; this harness uses the
   account's default Queue placement and does not establish EU/US Queue residency.
2. **Eligibility and cost:** verify existing Artifacts and Queues entitlements,
   current usage and pricing, and any account-specific terms. Actual incremental
   spending is **unknown**. **USD 1 total incremental cost is a proposed review
   ceiling, not authorized spending and not an enforceable billing cap.** If the
   reviewer cannot establish acceptable bounded exposure, do not run. There is no
   automatic upgrade, new paid subscription, payment-method change, or acceptance
   of new terms. Cloudflare currently states that Artifacts requires Workers Paid
   and that operation/storage billing begins October 14, 2026; Queues and the
   existing plan must be considered separately. Recheck pricing at execution time.
   [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)
3. **Data and destination:** approve only the synthetic `README.md` body
   `Artifacts smoke`, the synthetic Git identity `Smoke <smoke@example.invalid>`,
   seed and empty descendant commits (`Smoke candidate x`, `Smoke candidate z`,
   `Smoke publication`, `Smoke rejected publication`), directory commit
   `Smoke publication manifest`, note `Artifacts why`, the five named refs,
   tiny synthetic manifest/empty agent-directory files and resulting event metadata
   in the selected Cloudflare account. All exact names are in the version-2 plan.
   No customer, personal, pre-existing repository-history or production data is needed.
4. **Exact resources and credentials:** review the final generated names/counts,
   approve this one run, and obtain the required action-time authorization for
   the bounded token creation (including the two automatic bootstrap tokens).
   In default API-token mode, an existing short-lived, account-scoped credential must have Artifacts
   read/edit and the necessary Queue/event-subscription rights, including cleanup.
   Verify exact permissions before execution. The user must provide/configure
   secrets using a supported secure credential handoff, never chat, source files,
   plan JSON, Git URLs or command arguments. Any new credential or material access
   grant requires its own action-time confirmation; this script does not create
   that Cloudflare API credential.
5. **Deletion and recovery:** explicitly approve deletion of only this run's new
   synthetic repos and their tokens, subscription, HTTP pull consumer and Queue
   (including synthetic Queue messages). Repo deletion may be irreversible. No
   pre-existing resource is an approved target. Approve the run's bounded cleanup
   as well as creation, and choose a durable private ledger directory before
   starting. A cleanup error, 202 deletion still pending, timeout or ambiguous POST
   leaves the run failed/incomplete, never a false success.
6. **Time and approval expiry:** generate the final plan with verified targets
   using `--account-id`, `--account-name`, `--account-plan 'Workers Paid'`,
   `--namespace`, and `--jurisdiction`. Review that exact JSON and its UTC
   `expiresAt`; the approval is for that one run ID and one-hour plan window.
   New normal actions stop at expiry or the shorter 300-second run deadline;
   the separately approved cleanup budget is up to 120 seconds afterward.
   Reusing a run ID is refused. Regenerate and obtain fresh approval if the target,
   bounds, names, costs, credential scope or time window changes.

Only after those approvals and secure setup, the operator may use:

```sh
bash scripts/smoke-artifacts.sh --live \
  --plan-file /path/to/reviewed-as1-plan.json \
  --run-id EXACT_REVIEWED_RUN_ID \
  --ledger-dir /path/to/private-persistent-smoke-ledgers
```

The environment must contain `CF_ACCOUNT_ID` matching the plan and the securely
configured `CLOUDFLARE_API_TOKEN`. Do not paste either secret material or a live
command containing secrets into a transcript. A call without one explicit mode
(`--plan`, `--fake`, or `--live`) is blocked before network access.

## Optional private OAuth and split Queue control (code-only verified)

The default API-token mode above is unchanged. An alternative supports a separately
approved, existing Wrangler **4.149.0** OAuth session in an explicitly selected
private temporary HOME. This implementation and its tests **do not** initiate login,
read real credentials, call live APIs, or authorize a smoke run. Login approval is
separate from resource creation, bounded Git-token minting, cleanup and cost approval.

The login owner must first approve and verify only `account:read`, `user:read`, and
`artifacts:write`; Queue access must stay on the already connected Cloudflare tool.
Installed Wrangler supports `login --device --browser=false`. Login, scope review,
expiry/refresh policy, logout/revocation and removal of the temporary auth store are
owner gates outside this harness. Do not add Queue permissions to the CLI grant.

Only after the full live checklist and those auth gates, the future command is:

```sh
CF_ACCOUNT_ID=EXACT_REVIEWED_ACCOUNT_ID bash scripts/smoke-artifacts.sh --live \
  --plan-file /path/to/private-reviewed-plan.json \
  --run-id EXACT_REVIEWED_RUN_ID \
  --ledger-dir /path/to/private-persistent-ledgers \
  --auth-mode wrangler-oauth \
  --oauth-home /tmp/OWNER_SELECTED_PRIVATE_HOME \
  --oauth-xdg-config /tmp/OWNER_SELECTED_PRIVATE_HOME/config \
  --bridge-dir /path/to/private-bridge-root
```

The auth HOME must be an explicitly selected canonical directory below `/tmp`,
never the operator HOME. The default XDG path is `HOME/config`; an explicit different
XDG path must remain inside that HOME. Inherited `TMPDIR` cannot redirect selection.
Auth/bridge/ledger directories must be owner-owned, mode 0700 and non-symlinked.
The selected auth tree is metadata-checked only: all directories 0700, regular files
0600, no symlinks, hardlinks or special files, at most 256 entries/eight levels.
The login owner must establish those permissions; the harness never fixes them or
reads token files directly. Keep the plan and ledger files mode 0600 for the bridge
CLI. Bridge and ledger locations are explicit; neither is discovered in user homes.

The helper starts the pinned installed `wrangler auth token --json` from that private
HOME with a fresh allowlisted environment. It sets `WRANGLER_WRITE_LOGS=false`,
`WRANGLER_SEND_METRICS=false`, and `CLOUDFLARE_AUTH_USE_KEYRING=false`; strips ambient
API credentials, proxies, Node runtime hooks and debug settings; captures at most
16 KiB of total stdout/stderr; and kills the process group after at most ten seconds.
Only the exact JSON object `{"type":"oauth","token":"…"}` is accepted. API-token or
API-key fallback, extra fields, diagnostics, nonzero exit and malformed output fail
closed. No token is passed in argv/URLs, printed, written to bridge/ledger/evidence,
or saved by the harness. The official CLI may refresh an expired session and update
its selected private credential store; its JSON does not establish scopes or expiry.
If an approved refresh needs a network proxy absent from the isolated environment,
it fails; the harness does not silently inherit one or expand the grant. Same-user
process inspection and concurrent auth-store edits remain trusted-machine concerns.

### Connector orchestration contract

The bridge creates one exclusive `BRIDGE_ROOT/RUN_ID` directory and refuses reuse.
The bridge is **not** an authorization system or background connector integration.
A separately authorized orchestrator services requests with the existing Cloudflare
connector; file presence, login success and plan digests do not grant permission.

Prepare the orchestrator before starting the smoke. With each variable pointing to
an explicitly selected non-secret file/directory, claim ready requests atomically:

```sh
node dev/smoke-bridge.mjs --claim \
  --bridge-dir "$BRIDGE_RUN_DIR" --plan-file "$PLAN" --ledger-file "$LEDGER"
```

It prints a JSON array of newly claimed requests. `--pending` with the same options
is inspection only, **never** a dispatch instruction. Each claim is exclusive and
permanent: competing/repeated claims cannot dispatch the same POST twice. If the
orchestrator loses its place after claiming, do not remove the claim or retry the
external operation; let the smoke fail and reconcile the unknown outcome.

For each newly claimed request, check its `expiresAt` immediately, verify separate
live authorization, and execute exactly its `method`, `path` and optional `body`
through the Cloudflare tool. Paths are account-relative API paths beginning with
`/accounts/PLANNED_ACCOUNT/queues` or `/event_subscriptions/subscriptions`; they are
not arbitrary URLs. Never send its plan metadata to Cloudflare, attach CLI OAuth,
pass Authorization/headers to this bridge, or extend the deadline. Preserve the
actual HTTP status and API envelope. For the connected tool's returned object `r`,
use exactly this token-free normalization, omitting undefined `result_info`:

```js
{ status: r.status, value: { success: r.success, result: r.result, result_info: r.result_info } }
```

Do not copy `r.errors`, `r.messages`, headers or credentials. Provide the resulting
bounded JSON on stdin. For example:

```json
{"status":200,"value":{"success":true,"result":[],"result_info":{"total_pages":1,"total_count":0}}}
```

The example is an empty Queue inventory fixture, not a substitute for live results.
Write the response for that claim, using stdin rather than secret-bearing argv:

```sh
node dev/smoke-bridge.mjs --respond \
  --bridge-dir "$BRIDGE_RUN_DIR" --plan-file "$PLAN" --ledger-file "$LEDGER" \
  --request-id "$CLAIMED_REQUEST_ID"
```

Only required non-secret response fields are persisted; provider headers, diagnostics,
extra fields and errors are discarded. Queue-event responses retain only the bounded
synthetic source/ref, optional exact before/after OIDs and canonical event timestamp,
and acknowledgement lease IDs. All commit bodies and unrelated metadata remain excluded. Requests/responses are checked
against the recomputed complete plan, matching ledger, owned IDs, UUID, request hash,
method/path, and time window. Completed ledgers, wrong accounts, changed plans,
foreign IDs, duplicates, oversized responses, symlinks and expired replies fail
closed. Only planned Queue creation/inventory, one consumer/subscription, bounded
pull/ack, and cleanup of recorded new IDs are supported. Artifacts REST goes directly
through the in-memory private OAuth token; it never enters this bridge.

The original ten-second API deadline, 300-second run, 120-second cleanup and request
counts remain unchanged. Poll/claim promptly, normally several times per second;
if the tool/orchestrator cannot complete calls within ten seconds, **do not run**.
The dispatcher must set its provider deadline to the remaining request time, never
more than ten seconds. These deadlines bound local dispatch/acceptance; they do not
prove Cloudflare cancelled an in-flight action or prevent eventual remote completion.
Late/lost responses and claimed-but-unanswered POSTs are unknown outcomes requiring
manual reconciliation, never automatic redispatch. Timeouts and ambiguous creates
stay failed/pending in the durable ledger. A 202
Queue/subscription/consumer deletion is not considered confirmed cleanup. A local
mock exchange is not live Queue, connector or Artifacts acceptance evidence.

## Optional per-launch Git transport

Default Git subprocesses still inherit no proxy or extra CA settings. In execution
environments that require a platform loopback proxy, a separately reviewed live run
may add `--git-transport-config /path/to/private-transport.json`. This option changes
only URL-scoped configuration in that run's Git subprocesses. It does not modify
Git's global configuration, the OS trust store, network settings or OAuth environment.

The config is an owner-owned regular mode-0600 JSON file in a private mode-0700
directory, with exactly `version`, `proxy`, `caFile` and `caSha256`. `version` is 1.
Only `http://127.0.0.1:PORT` with an optional root slash is allowed: no credentials,
alternate host, non-root path, query, fragment, encoded aliases or invalid port.
The optional root slash is normalized. The port is **per execution**; never copy
one from an earlier invocation. In explicitly enabled live transport mode, the
config endpoint must equal that invocation's validated `HTTPS_PROXY` after that
normalization. Missing, malformed or stale/mismatched values stop before OAuth,
bridge setup, Cloudflare requests or Git. Default, plan and fake modes never read
that environment property or the transport config. Plan/fake reject this CLI flag.

The trust source is pinned to the public CA file
`/usr/local/share/ca-certificates/nebula-dns.crt`, SHA-256
`ab6933a81e6f0d142e6d5f58ed465589d899a523c2752055761af11d4ee38f2b`.
It must be a canonical regular non-linked file owned by UID 65534, mode 0644 or
0444, at most 128 KiB, with the exact fingerprint. Config reads are capped at
4 KiB. No arbitrary certificate, symlink, hardlink or mutable hash override is
accepted. After verification, the public CA bytes are copied once using exclusive
mode-0600 creation into the smoke's private temporary Git HOME. Git uses that
snapshot, so a later source-path replacement cannot change the verified bytes.
The snapshot is removed with the local temporary directory.

For a future authorized launch, first choose a new private config path. Create and
consume it in the **same execution invocation/process tree** as the full approved
live smoke command. This token-free preparation reads only the current platform
proxy, validates it and writes the explicit non-secret config; it does not log it:

```sh
node --input-type=module - "$PRIVATE_CONFIG" <<'JS'
import { open } from 'node:fs/promises';
import { PLATFORM_CA, validatePlatformProxy } from './dev/smoke-transport.mjs';
const proxy = validatePlatformProxy(process.env.HTTPS_PROXY);
const file = await open(process.argv[2], 'wx', 0o600);
try {
  await file.writeFile(JSON.stringify({ version: 1, proxy,
    caFile: PLATFORM_CA.path, caSha256: PLATFORM_CA.sha256 }) + '\n');
  await file.sync();
} finally { await file.close(); }
JS
# In this same invocation, use the full reviewed live command above with:
# --git-transport-config "$PRIVATE_CONFIG"
```

A later tool invocation may have a different proxy port and needs its own freshly
reviewed config. The harness never falls back to an old port, reads other proxy
variables, or imports ambient `SSL_CERT_FILE`, tracing, credentials or Node hooks.
It records only the chosen non-secret proxy and pinned source CA identity in the
ledger. The loaded transport is immutable and bound to the exact validated
account/namespace/repository remote and private Git HOME. Only that remote receives
`http.<remote>.proxy`, `http.<remote>.sslCAInfo`, and explicit
`http.<remote>.sslVerify=true`. Existing credential-helper/hook isolation and
`http.followRedirects=false` remain in force. No TLS-verification bypass is allowed.

Git failures now report a fixed phase and sanitized category, such as
`GIT FAIL main_push: git_dns (diagnostics suppressed)`. Categories distinguish DNS,
proxy DNS/authentication, TLS, repository authentication/not-found, connection,
timeout, unsupported atomic push, non-fast-forward, stale expected-old info, output-limit and unknown failure.
They are bounded diagnostic hints derived from at most 16 KiB of stderr, never raw
stderr, URL credentials, tokens or arbitrary server text. The existing combined
output cap and process-group deadline still apply. Transport failures during any
publication stage remain transport failures. The deliberate stale-main probe accepts
only `git_stale_info`; rebuilt-notes rejection is a separate local test and is not a
live-smoke claim. The stale-info category and new phase names are additive changes;
private OAuth, URL-scoped proxy, pinned CA and TLS verification guards are unchanged.

Local tests validate the explicit config, pinned public CA and actual Git URL-match
behavior without using Git network transport or real credentials. Those tests do
not establish live connectivity, the full cause of an earlier failure, or permission
to run another cloud smoke. Another live run remains separately approved.

## Fail-closed lifecycle and recovery

Before creation, the script verifies the existing namespace, refuses either
pre-existing repo name or Queue name, and refuses an incomplete Queue inventory.
It does not adopt resources. A successful POST's IDs/names are recorded in an
exclusive, mode-0600 ledger before subsequent work. A creation intent is written
first; interruption or an ambiguous response leaves an explicit unknown outcome.
Unknown resources are never guessed, adopted, retried, or deleted by name.

The ledger uses a private owner-controlled directory, exclusive creation and random
exclusive staging files for updates (no predictable followable `.next` path). It
lives outside the ephemeral working tree, survives normal cleanup,
and contains only the plan, resource/token IDs, safe status, and safe outcomes.
Use a durable owner-controlled directory outside the repository. The script
refuses to overwrite the same run ID. It does not replace this document with a
live transcript. Record a future run's status from its retained ledger instead.

Name-addressed repo mutations and deletion recheck the recorded repo ID. A
replacement or unknown repo is left untouched and reported. Cleanup removes the
new subscription, revokes tokens and deletes the two new repos, then removes the
new consumer and Queue by recorded IDs. A repo deletion response is asynchronous;
the harness checks for absence with bounded polling before calling it cleaned.
Other cleanup failures are printed, persisted, and make the exit code nonzero.
SIGKILL, machine failure, lost API replies, or ledger write failure can still leave
resources: operation deadlines are not a cloud TTL. No automatic cleanup retry
or separate cleanup tool is enabled. For recovery, inspect the ledger's exact
account, names, IDs, pending intents and cleanup failures; verify ownership and
current identity read-only, then obtain the necessary approval for only those
remaining synthetic resources. Never expand deletion to similarly named or
pre-existing resources. Unconfirmed resource/token expiry requires follow-up.

The smoke client's Git commands get an allowlisted environment, isolated home/config, disabled credential
helpers/client hooks/redirects, an output cap, and a killable process-group timeout.
The Cloudflare API credential and inherited user Git settings/tracing are absent.
Only the repository token is passed via ephemeral URL-scoped Git configuration in
the child environment; it is absent from argv, URLs, remotes and logs. Same-user
process/environment inspection is still a reason to use a trusted execution
machine. The credential-free plan needs no secure setup.

## Publication gates

Atomic push is no longer required by this deliberately revised protocol. This is
not an automatic fallback after an atomic failure: a different reviewed version-2
plan is required. Old atomic plans fail validation. Main-last publication requires
exact staged proofs and an expected-old main CAS; main is never advanced merely
because the requested ref names exist. A stale rejection must leave the old
publication intact, as confirmed by clone and final readback. Any proof mismatch,
unrecognized rejection, clone failure, deadline or cleanup failure makes the run
nonzero. The test does not prove concurrency recovery for arbitrary real histories.

Production parents rebuilt notes on the remote notes tip, preserves immutable
manifest history, and uses recovery tests beyond this transport probe. Ordinary
auxiliary refs can remain ahead/pending after interruption, so consumers must select
the immutable manifest by exact published main. Notes compatibility rejection and
transport/authentication failures remain distinct. Event failure requires R3:
alarm polling while lanes are active. Local fake results cannot settle a live
service, event, full recovery, or deployment gate.

API references checked for this implementation:
[Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/),
[authentication](https://developers.cloudflare.com/artifacts/guides/authentication/),
[event schemas](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/),
[Queue list](https://developers.cloudflare.com/api/resources/queues/methods/list/),
[subscription lifecycle](https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/).
