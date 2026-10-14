# Heddle on Artifacts: competition architecture and work split

**Entry:** Cloudflare "Build the Next-Gen Git Platform" competition.
**Deadline:** Wed **Oct 14, 2026, 23:59 PDT**. That is Oct 15, 08:59 CEST on the build box.
**Owner decision (2026-10-10):** pivot. Cloudflare Artifacts holds the Git; Heddle is the coordination brain.
**Status:** decided. Builders start from this document. Anything still marked *GATE* is resolved by a time-boxed spike, and each gate already has a named fallback.

---

## 0. Facts this design rests on (researched 2026-10-10)

The task's Captures panel reads `GET /api/projects/:project/tasks/:task/captures` with the same access rules as the task read. The engine reconstructs every non-reviewer lane's timeline from its stored `lane.seen`, ordered by capture time, and asks Heddle for semantic changes from the task base to the first capture, then between successive captures in that lane. Results (including `unavailable`) are cached by from/to State IDs in `engine.json`; the worker snapshots newly computed entries to R2 and advances its restore memo. Because the read can rewrite `engine.json`, the coordinator runs it in the same serial engine queue as mutating commands. Each read computes at most one uncached pair, with a ten-second process deadline and an 8 MiB output limit, returning the rest as `pending` for bounded UI polling. A Heddle error or unexpected output caches `unavailable`; a timeout instead records an attempt and leaves the pair `pending` for a later read, and only the third timed-out attempt caches `unavailable`. Tracks share a time axis, span the first through last capture, and support selection and chronological keyboard navigation across lanes; push and candidate feed events refresh the history.

### Competition terms
From the terms PDF, sections 2–6, and the blog post.

**Window and eligibility**
- The contest runs Oct 1 09:00 EDT to Oct 14 23:59 PDT.
- Entrants must be US or Canada residents aged 18+.
- One submission per entrant.

**Hard requirements**
- The project is built on the Cloudflare developer platform, "including Cloudflare Workers and Artifacts".
- It "must enable multiple agents working on changes concurrently".
- Source is MIT, Apache-2.0 or BSD, with a LICENSE file in the repo.

**Deliverables**
- A 5–10 minute demo video.
- The repository.
- Instructions for running the project.

**Judging** (each criterion scored 1–5):

| Weight | Criterion |
|---|---|
| 50% | Originality and quality of the prototype for agent-oriented software collaboration |
| 25% | Multi-agent concurrency, coordination, context preservation, review and conflict handling |
| 25% | Ease of use and UX |

- Ties are broken on originality.

**Finalists**
- Three finalists each present live for 10 minutes at Cloudflare Connect, SF, on **Oct 21**.
- The winner must be physically present, so the owner should hold that date.

**Positioning.** The blog post says: "We aren't looking for GitHub as it exists today with agents added on top." Our answer is that a conflict is not a failed push. It is a set of signed, attributed alternatives that a team decides between, and the decision travels with the code inside plain Git.

### Cloudflare Artifacts (open beta, Workers Paid)

**Workers binding.** Configured with `[[artifacts]] binding="ARTIFACTS" namespace="…"`.
- Namespace methods: `create(name, {readOnly, description, setDefaultBranch})`, `get(name)`, `list`, `import`, `delete`.
- Repo handle methods: `info()`, `createToken(scope "read"|"write", ttlSeconds)`, `listTokens`, `revokeToken`, `fork(name, {defaultBranchOnly, readOnly, description})`, `log({ref, limit, offset})` (first-parent), `readCommit`, `readTree`, `readBlob`, `readFile({ref, path})`.
- **The binding cannot write content.** All writes go through the Git protocol, either the git CLI or isomorphic-git.

**Git protocol**
- Smart HTTP at `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`.
- Clone and fetch support protocol v1 and v2. **Push is v1 only.** The `filter` capability (partial clone) is not supported.
- Auth is `Authorization: Bearer art_v1_…`, or Basic auth with the token secret as the password.
- Tokens are **repo-scoped** (`read` or `write`) and carry their expiry in the `?expires=` suffix.

**Events**
- Account-level source `artifacts` covers `repo.created/deleted/forked/imported`.
- **`pushed` is repo-level only.** The source is `artifacts.repo` and a subscription needs `--source-namespace` and `--source-repo-name`. Each fork therefore needs its own subscription, created through the REST API or with `wrangler queues subscription create <queue> --source artifacts.repo --events pushed --source-namespace N --source-repo-name R` (verified in wrangler 4.149.0 `--help`).
- The `pushed` payload has `ref`, `before`, `after` and `commits[]` (author, committer, message, parents). Events are delivered to a Queue.

**Limits and pricing**
- 2,000 control-plane requests per 10 s per namespace.
- 2,000 Git requests per 10 s per repo.
- 1 GB per repo, 32 MB per blob, 1 TB per account.
- Unlimited repos.
- Billing starts **Oct 14/15**: 10k operations and 1 GB-month included, then $0.15 per 1k operations and $0.50 per GB-month. Recheck the provider's current pricing and obtain a bounded usage approval; the harness does not enforce a provider billing cap or verify the final invoice.

**Live compatibility status, October 10** (Track A, test A-S1)
- A2 accepted a synthetic main, a candidate ref and `refs/notes/heddle-why`, plus repository fork/token operations. It did not reach clone or exact remote readback.
- A2 rejected `--atomic`. The integrated engine now implements an explicitly recoverable main-last publication protocol; it stages immutable proof snapshots and advances main with an expected-old lease after verification. Auxiliary aliases can be pending. See `engine/README.md` and `docs/SMOKE.md`.
- Revised live ordered publication, clone/readback and Queue delivery remain gated until their own successful run. Non-fast-forward notes compatibility was not reached; production parents notes rather than unconditionally replacing them.

### Containers
- A container is addressed per Durable Object name, as in `getContainer(env.X, name)` / `getByName`. Each name is its own instance, so there is **no single-flight requirement**.
- Cold start is typically 1–3 s, and disk is ephemeral.
- `ctx.container.exec(cmd[], opts)` (GA June 2026) runs processes with streamed stdin and stdout, so no HTTP server is needed inside the image.
- `standard-1` gives 0.5 vCPU, 4 GiB and 8 GB disk. Custom instances go up to 4 vCPU, 12 GiB and 20 GB.
- Outbound HTTP(S) can be intercepted by a Worker, which is a stretch option for token injection.

### Workers
- Bundles can be 64 MiB uncompressed.
- CPU time is up to 5 min per request on Paid.
- Durable Objects use SQLite storage, alarms and hibernatable WebSockets.

### Heddle in WASM (verified by real `cargo check --target wasm32-unknown-unknown` on 0.30.0 code)

| Crate | Result |
|---|---|
| `heddle-format` | Compiles |
| `heddle-object-model` | Compiles with the getrandom `wasm_js`/`js` and `uuid/js` features |
| `heddle-crypto` | Compiles with the same features |
| `heddle-thread-api`, `signing` feature only | Compiles with the same features |
| `heddle-thread-api` defaults or `replication` | Fails on `mio` |
| `heddle-objects`, `heddle-refs` | Fail on `fs2` |
| `heddle-repo`, `heddle-git-projection` | Fail on `errno` via rustix → cap-primitives → sley-worktree; the graph also includes `ring`, `memmap2` and `zstd-sys` |

- Storage traits exist: `ObjectStore`, `RefBackend` and `OpLogBackend`, with `Repository<R,O,S>` generic over them. But capture and init are written against the filesystem.
- **Conclusion:** capture, conflict handling and Git projection **cannot run in a Worker this week**. Heddle runs as its **CLI (now 0.31.1) inside a Cloudflare Container**. WASM is only an optional stretch: in-Worker signature verification badges using object-model and crypto.

### Heddle CLI surface we use (0.30.0, unchanged in 0.31.1)
The release is `878fea43` on `origin/main`. **Its tag is not yet cut.** The `heddle-cli` crate is **not** on crates.io past 0.23.0. GitHub release binaries exist up to v0.28.10, including x86_64 Linux.

| Need | Heddle surface |
|---|---|
| Per-agent lanes | `heddle agent fanout plan/start` creates task assignments and materialized child lanes; `heddle start` creates a thread |
| Writer lease per lane | `heddle agent reserve` / `heartbeat` / `capture` (token-authenticated) / `ready` / `release` |
| Per-agent signing key, no weft | `$HEDDLE_HOME/device-identity.toml` (`public_key`, `private_key_pem` PKCS#8 ed25519, `server`, `linked_at`) supersedes the per-repo `identity.toml`. With **one `HEDDLE_HOME` per agent**, every capture is signed by that agent's key (`repo/src/identity.rs`). |
| Agent provenance | `heddle agent provenance begin/segment/end`; env `HEDDLE_AGENT_PROVIDER/MODEL/POLICY`; `Attribution{principal, agent}` |
| Conflicts become candidates | ADR-0053: a conflicted State carries a Conflict Set of attributed **Conflict Candidates**. Resolution is an attributed successor operation that cites the exact Conflict Version and fails closed when stale. CLI: `heddle resolve --heads` lists a Thread's concurrent source heads, `--pick <head>` takes one, `--merge <head>` merges one. |
| Discussion and the "why" | `heddle discuss open/reply/resolve --into-annotation (rationale|constraint|invariant)` produces signed, anchored discussion turns |
| Review | `heddle review show/approve/ready`, using the signing identity |
| Git projection | `heddle git import <url> --ref …`, `heddle git export --destination <bare>`. Export already writes **`refs/notes/heddle`** (change_id, agent, confidence, status) and the trailers **`Heddle-State` / `Heddle-Change`**. |

---

## 1. Architecture

### 1.1 One-paragraph summary
Every agent gets its **own Artifacts fork** and a repo-scoped write token, and pushes with plain `git push`.

- **The push path never touches our compute.** Concurrency is Artifacts' problem, and it is built for millions of repos.
- **Notification.** A push event, from a Queue subscription or a Durable Object alarm poll as fallback, reaches the project's **ProjectDO** coordinator.
- **Ingest.** ProjectDO asks the project's **Heddle Engine Container** to ingest the push. The engine runs the agent's commit through its child lane under its writer lease, and **signs the capture with that agent's own key**.
- **Conflicts.** Overlapping lanes produce a Heddle **conflicted State with attributed Conflict Candidates**. Candidates are published back to the canonical Artifacts repo as `refs/heads/candidates/<task>/<agent>`, pointing at the agent's exact commits.
- **Review.** A reviewer agent (Workers AI) and a human discuss in signed Heddle discussions.
- **Decision.** A decision page on the Worker calls `resolve --pick`, signed by the decider. Heddle lands the result and projects it to `main`, together with `refs/notes/heddle` and `refs/notes/heddle-why`.
- **What plain Git shows.** `git clone` followed by `git log --notes='heddle*'` shows who did what, what the alternatives were, and why one was chosen. The projection is byte-exact and reproducible.

### 1.2 Components

```
                    ┌────────────────────────────── Cloudflare account (Heddle) ──────────────────────────────┐
                    │                                                                                         │
 humans (browser) ──┼──► Worker "heddle-artifacts"  (single script, TS)                                       │
 agents (curl/ha) ──┼──►   ├─ /api/*   control API (projects, tasks, enroll, discuss, decide, why)            │
                    │      ├─ /p/*     decision UI (static assets + JSON, WebSocket live feed)                │
                    │      ├─ queue()  consumer for "artifacts-events" ◄──────────── Queue ◄── event subs    │
                    │      ├─ reviewer (Workers AI binding env.AI)                                ▲ (pushed,  │
                    │      └─ DO classes:                                                         │  per fork)│
                    │           ProjectDO (SQLite)  one per project: registry, lanes, candidates, │           │
                    │             decisions, op journal, WS hub, alarm poller, engine op queue    │           │
                    │           HeddleEngine (Container DO) one per project ─ exec(["engine",…])  │           │
                    │                │  /state = heddle repo + per-agent HEDDLE_HOMEs              │           │
                    │                │  snapshot/restore ⇄ R2 bucket "heddle-artifacts-state"      │           │
                    │                ▼ git fetch (read tokens) / git push (write token, canonical)  │           │
                    │  Artifacts namespace "heddle-demo"                                           │           │
                    │     <p>                       canonical repo: main, candidates/*, notes ────┘           │
                    │     <p>--<task>--<agent>      one fork per (agent, task); agent's own write token       │
                    └─────────────────────────────────────────────────────────────────────────────────────────┘
 agents: plain git ── push ──► their fork (direct to *.artifacts.cloudflare.net; never via our Worker)
 anyone: plain git ── clone/fetch ──► canonical <p> (read token) → main + candidates/* + refs/notes/heddle*
```

| Component | Cloudflare product | Owns | Track |
|---|---|---|---|
| `heddle-artifacts` Worker | Workers + Static Assets | HTTP API, UI, queue consumer, reviewer | A (API, queue), C (UI), D (reviewer) |
| `ProjectDO` | Durable Object, SQLite | Source of truth for coordination metadata: agents, lanes, forks, candidate index, decisions, the op journal and the WebSocket fan-out. Serializes engine operations per project. | A |
| `HeddleEngine` | Container (`@cloudflare/containers` Container class, one instance per project via `getByName(projectId)`, `standard-1`) | The Heddle repo and the Heddle CLI 0.30.0. All Heddle semantics live here. | B |
| `artifacts-events` | Queue + event subscriptions | Push notifications from forks | A |
| `heddle-artifacts-state` | R2 | Engine `/state` snapshots (`projects/<p>/gen-<n>.tar.zst`) | A (plumbing), B (format) |
| Artifacts namespace `heddle-demo` | Artifacts | Canonical repo per project and a fork per (agent, task) | A |
| Workers AI | Workers AI | Reviewer agent model | D |

### 1.3 Where Heddle runs, and why
**Decision: in a Container, as the stock Heddle 0.30.0 CLI, driven by a small Node `engine` program over `exec()`. One engine instance per project.**

1. **Heddle cannot run in a Worker.** Real wasm32 checks show repo, objects, refs and git-projection blocked on `errno`/rustix, `fs2`, `ring`, `memmap2` and `zstd-sys`. Porting them is weeks of work, not days.
2. **The CLI already has every verb we need:** fan-out lanes, writer leases, per-agent signing, ADR-0053 conflict candidates, discussions and annotations, and Git export with notes and trailers. **Target: zero Heddle code changes.**
3. **Git transport is independent of engine serialization.** Here Git transport is Artifacts. The engine sits **off the push path**: it ingests asynchronously, batches, and is one instance per project. The bounded single-project demo currently caps Containers at one instance; Git transport does not wait on that engine's writer lease. Multi-project capacity is not established by the demo.
4. **State persistence.** The Heddle repo lives on container disk and is snapshotted to R2 after every mutating operation; ProjectDO compare-and-swaps `stateGeneration`. On a cold start the engine restores the latest generation by streaming it from R2 into `exec` stdin. Tokens and the R2 credential never live in the image.
   - *Rejected: DO storage* (Heddle needs a filesystem).
   - *Rejected: an Artifacts repo for Heddle-native state* (Heddle's format is not Git; Artifacts is the Git face).

### 1.4 Data flows

**F1. Create a project.** The operator calls `POST /api/projects`.
- ProjectDO calls `ARTIFACTS.create(p)` and mints a short-lived write token.
- It calls `engine init`. The engine seeds the repo from a template or an import URL, runs `heddle init` and imports `main` into Heddle's `main` thread, then publishes to the canonical repo.

**F2. Create a task and enroll agents.** The operator calls `POST …/tasks`, then `POST …/tasks/:t/agents`.

For each agent, ProjectDO:
1. forks `p` to `p--t--agent` with `defaultBranchOnly`;
2. mints a fork **write** token and a canonical **read** token, both with a 12 h TTL;
3. creates a `pushed` event subscription for the fork via the REST API;
4. calls `engine agent.enroll`, which mints an ed25519 key into `/state/agents/<a>/home/device-identity.toml` and returns the public key;
5. calls `engine lane.open`, which creates the fan-out child lane `task/<t>/<a>` and runs `heddle agent reserve` to take the writer lease. The lease token stays inside `/state`.

The response gives the agent a setup script. It sets `origin` to the fork and `upstream` to canonical, passing the Bearer token as `http.<url>.extraHeader` so the token is never stored in a URL.

**F3. Push to capture to candidate (concurrent).**
```
agent ─git push origin HEAD:main──► Artifacts fork p--t--a   (no Heddle on this path; N agents = N repos)
      Artifacts ─ cf.artifacts.repo.pushed ─► Queue ─► Worker.queue() ─► ProjectDO.notePush(fork, ref, after)
      (fallback: ProjectDO alarm every 3 s while lanes are active: repo.log({ref:"main",limit:1}) per fork)
ProjectDO: dedupe on (lane, sha) → journal op → engine queue (one in flight per project; coalesces bursts)
Engine ingest (batch of k pushes):
  git fetch <fork> <sha>  (read token in exec env, 10-min TTL)
  materialize commit tree into lane checkout → HEDDLE_HOME=/state/agents/<a>/home
  heddle agent capture --token <lease> -m "<commit subject>"  (+ provenance: provider/model)
  → signed State on lane task/<t>/<a>
  integrate preview into task/<t>: no overlap → lane is a clean candidate;
     overlap → Git merge-tree conflict preview attributed to the two signed lane candidates (G2 b2)
  run project tests in the lane checkout (≤60 s budget) → evidence
  publish: push refs/heads/candidates/<t>/<a> = agent's ORIGINAL commit sha to canonical
  snapshot /state → R2 (gen n+1)
ProjectDO: update candidate index → WS event candidate.ready → UI updates live → reviewer triggered
```

**F4. Review and discussion.**
- Once at least two candidates exist, or a candidate has no conflict and its tests have passed, ProjectDO calls the reviewer with diffs, test results and the task intent. The reviewer returns structured JSON.
- `engine discuss` records the review as a turn signed by the **reviewer agent's own key**.
- Humans post replies from the UI. Each reply becomes `heddle discuss reply`, signed by that human's key.

**F5. Decision, land, main.** The human picks a candidate and writes a rationale on `/p/:p/t/:t`.
1. The browser calls `POST …/decision {pick, rationale, expectHeads}`.
2. ProjectDO checks that `expectHeads` matches the current candidate set; if not, it returns 409 (stale and fail-closed, mirroring ADR-0053).
3. The engine, running as the decider's `HEDDLE_HOME`, does three things:
   - named G2 b2 fallback: `heddle thread absorb <chosen-lane> --into <task>`; this is not an ADR-0053 concurrent-head resolution;
   - `heddle discuss resolve --into-annotation --kind rationale`;
   - lands `task/<t>` into `main`, with the landing message holding the rationale and `Heddle-Task/Chosen/Alternative` lines.
4. `engine publish` runs `heddle git export` into `/state/export.git`, writes `refs/notes/heddle-why`, and pushes `main`, `candidates/*`, `refs/notes/heddle` and `refs/notes/heddle-why` to canonical.
5. It verifies byte-exactness (§4.3).
6. ProjectDO broadcasts `decision.landed`. Losing lanes are released with status `abandoned` and stay addressable as recorded alternatives.

**F6. Clone and see why.**
```sh
git -c "http.extraHeader=Authorization: Bearer $READ" clone https://<acct>.artifacts.cloudflare.net/git/heddle-demo/<p>.git && cd <p>
git fetch origin '+refs/notes/*:refs/notes/*'
git config notes.displayRef 'refs/notes/heddle*'
git log -3            # landing commit: rationale + Heddle-* lines; notes show agent/decision/alternatives
git log --oneline origin/candidates/parser-escapes/alice   # the losing alternative, still there, exact SHA
```

---

## 2. Concurrency model

1. **Push concurrency has no shared mutable ref.** Each (agent, task) has its own Artifacts repo. Ten agents pushing at once means ten repos each taking one push, against limits of 2,000 Git requests per 10 s per repo. Nobody is rejected and nobody waits on Heddle.
2. **Coordination is serialized per project, asynchronously.** ProjectDO is the single writer for project metadata. Its engine queue allows one in-flight `exec` per project and **coalesces** everything that arrived while busy into one batch ingest: one `git fetch` per fork, run in parallel inside the container, then sequential captures. Ingest is idempotent on `(lane, sha)` through the op journal, so a duplicate event plus a poll detection produces one capture.
   - Expected latency is about 1–3 s per capture plus tests. With three agents, a candidate appears within roughly 5–10 s of a push.
   - Different projects run fully in parallel, each with its own DO and container.
3. **Scaling story (for the video; not built).** Today the unit of serialization is the project, the same as any Git host's per-repo ref lock, but it sits *off* the push path. Next steps: per-task engine shards that federate into the project with `heddle push/pull`, and moving read paths (candidate index, diffs) into DO and KV caches.
4. **Conflicts become candidates, not rejections.**
   - Every push becomes a signed State on that agent's lane. A lane head is a **candidate**.
   - The engine computes an integration preview of all lanes against `task/<t>`. Non-overlapping lanes are "clean candidates".
   - The selected stock CLI path uses **G2 fallback b2**: `git merge-tree` previews overlapping Git changes, and the UI compares the separately signed native lane Captures. It does not claim an ADR-0053 Conflict Set or concurrent native source heads.
   - A decision checks the exact reviewed candidate States, absorbs the selected lane, and records a custodial signed attestation of the native discussion-resolution envelope and decision fields. A stale candidate set fails closed with 409.
5. **Writer lease = fork token.** The lease and the Artifacts write token are minted together at enrollment and revoked together: `heddle agent release` plus `revokeToken`. An agent can only influence its own lane.

---

## 3. Attribution model (simplest secure approach; no weft, no biscuits)

| Layer | Mechanism | What it proves |
|---|---|---|
| Git transport | Artifacts write token scoped to **one fork**, 12 h TTL, revocable | Only agent A can put commits into `p--t--A` |
| Routing | ProjectDO maps fork to (agent, task, lane). This mapping is set at enrollment and never taken from request input. | A push event from fork A can only become input to lane A |
| Heddle write authority | Writer lease (`heddle agent reserve`) on lane `task/<t>/A`; capture uses `heddle agent capture --token` | Only A's lease can capture onto A's lane |
| Signature | Capture runs with `HEDDLE_HOME=/state/agents/A/home`, which holds A's own ed25519 `device-identity.toml` (`server = "local:heddle-artifacts"`). The State embeds A's public key and signature. | A State is verifiably A's, and verification needs no registry (the public key is embedded and the content hash is recomputed) |
| Provenance | `HEDDLE_AGENT_PROVIDER/MODEL` set from enrollment metadata, plus `agent provenance begin` | Which model or harness produced the work |
| Directory | ProjectDO `agents` table holds the public keys. They are published at `refs/notes/heddle-why` and in `.heddle-agents.json` on the `heddle/agents` branch. | Anyone can match signatures to names |

- **Humans and the reviewer** each get their own `HEDDLE_HOME` and key in the same way. Discussion turns and decisions are signed per person or agent.
- **Honest caveat, stated in the README.** Keys are held by the engine (custodial), and the R2 bucket is private. Git clients receive fork credentials, not native keys. Candidate code must not execute beside those keys unless its complete tree matches the separately reviewed demo allowlist; arbitrary candidate execution is withheld. This is a controlled demo, not a general untrusted-code sandbox.
- **Stretch: non-repudiable Git commits (Track B, 2 h).** Agents SSH-sign their commits (`gpg.format=ssh`) and register their SSH public key at enrollment. Ingest runs `git verify-commit` against an `allowed_signers` file and rejects mismatches when `requireSignedCommits` is on.
- **Untrusted fields.** The Git author name and email in agent commits are recorded but never trusted. The Heddle attribution comes from the lane.

**GATE G1 (Track B, Sun Oct 11 10:00 PDT).** Confirm that a hand-written `device-identity.toml` under per-agent `HEDDLE_HOME` signs offline captures and `agent capture` with that key.
- *Fallback 1:* one Heddle checkout per agent, each with its own `.heddle/identity.toml`. Lanes are serialized anyway, so swapping is safe.
- *Fallback 2:* the engine adds an ed25519 attestation over (task, agent, sha, stateId) using the agent's key (node:crypto) and records it in `refs/notes/heddle-why`. Captures are still made under the agent's lease.

---

## 4. Git surface

### 4.1 Canonical repo `<p>` (namespace `heddle-demo`)

| Ref | Writer | Content |
|---|---|---|
| `refs/heads/main` | engine only | Heddle's `main` thread projected by `heddle git export`. Each landing commit carries the rationale, `Heddle-Task/Chosen/Alternative/Decided-by` lines, and Heddle's footer `Heddle-State`/`Heddle-Change`. |
| `refs/heads/candidates/<task>/<agent>` | engine only | **The agent's original pushed commit, same SHA.** Losers stay forever as recorded alternatives. |
| `refs/notes/heddle` | engine via `heddle git export` | Untouched Heddle machine-note blobs keyed to native exported commits. The fixed G3 fallback landing SHA has native State/Change trailers and a separate why note; it need not have a machine note directly attached. Notes commits may be parented onto the remote tip without changing their tree. |
| `refs/notes/heddle-why` | engine | Human-readable narrative per landing commit and per candidate commit (format in §7 contracts) |
| `refs/heads/heddle/agents` | engine | `.heddle-agents.json`: agent id, kind, display name, ed25519 public key, provider/model |

**Fork `<p>--<task>--<agent>`.** It starts as `main` of canonical at fork time (`defaultBranchOnly`). The agent pushes to its fork's `main`, and only that ref is watched. To rebase after a land: `git pull upstream main`.

**Why a second notes ref.** `refs/notes/heddle` is rebuilt wholesale by Heddle on each export (`rebuild_notes`, which does not parent on the current ref) and is parsed back by Heddle. Appending our own prose would either be wiped or break Heddle's parser. Setting `notes.displayRef='refs/notes/heddle*'` shows both refs in one `git log`.

### 4.2 What plain Git sees
- `git log main` shows a linear-or-merge history of signed Heddle states. Authors are the agents' Heddle principals, and the bodies contain the rationale.
- `git log --notes='heddle*'` adds per-commit agent and status from Heddle, plus the decision narrative: intent, candidates with test results, review summary, the human rationale, and the decider's key fingerprint.
- `git branch -r` lists `candidates/<task>/<agent>` for every alternative ever considered.
- No custom client and no Heddle install are needed. Running `heddle` locally is optional, for deep inspection.

### 4.3 Byte-exactness guarantees (each one is an engine acceptance test and appears in the video)
1. **Candidates are untouched.** `git rev-parse candidates/<t>/<a>` equals the SHA the agent pushed, which is checked against the captured immutable candidate snapshot at publish. A later mutable fork tip does not rewrite an already signed decision.
2. **The landed content is identical to the chosen work.** For a whole-candidate pick on the same base, `git rev-parse main^{tree}` equals `candidates/<t>/<chosen>^{tree}`.
3. **The projection is reproducible.** Re-running stock `heddle git export` from the restored `/state`, followed by the persisted G3 fixed `commit-tree` projection, produces the same adapter landing `main` SHA. Stock export alone is not claimed to reproduce the fallback commit.
4. **Objects are well-formed.** A fresh `git clone` passes `git fsck --strict`, and a repack passes `git index-pack --strict`. This is the same evidence standard the prototype used.

*Rejected for main:* fast-forwarding `main` to the agent's own commit. That cannot carry the decision trailers or Heddle's signed history. Candidate refs already preserve the agent's exact commits.

---

## 5. Reuse from the prototype (`origin/cloudflare-git-gateway`, 8b993cfe)

| Piece | Verdict | Why |
|---|---|---|
| `gateway_view` / `gateway_write` / `gateway_received` / `gateway_publication` (git-projection modules) | **Drop** | Unmerged, so not in 0.30.0. They exist to serve Git *from* the container, which is the bottleneck we are removing. Artifacts now serves Git. |
| Python gateway, `git http-backend` serving, catalog/manifest pinning, native frame protocol, biscuit PoP sessions, `max_instances:1` / `busy→429` | **Drop** | Superseded by Artifacts transport and per-project engine instances. Biscuits are explicitly out of scope. |
| `worker/index.mjs` and `catalog.mjs` Artifacts binding usage and test doubles | **Reuse the pattern** | `get()`/`using` disposal, bounded reads and test-double shape seed Track A's `FakeArtifacts` |
| `worker/cloudflare/hosted-container-runtime.mjs` | **Reuse the pattern** | `startAndWaitForPorts`, deadlines, abort handling, env fingerprinting. Re-key to `getByName(projectId)` and replace 429 with a queue. |
| `Dockerfile.hosted` runtime stage (debian trixie-slim, git, non-root uid 65532, no secrets in image) | **Reuse** | The engine image base. Swap the Rust build stage for downloading the signed `heddle-v0.30.0-x86_64-unknown-linux-gnu.tar.gz`. |
| Security posture: fail closed, allowlisted headers, bounded bodies, no tokens in URLs or logs | **Reuse as review checklist** | Applies to every track |
| Evidence discipline (`index-pack --strict`, fsck, recorded outputs) | **Reuse** | Becomes §4.3 tests |

---

## 6. Repo and licensing

**Decision: a new repo, `HeddleCo/heddle-artifacts`, Apache-2.0, public from day 1.**
- A public repo gets free Actions minutes. Nothing in it is secret, and Heddle is already public under Apache-2.0. *Owner confirms visibility; the fallback is private now and flipped public by Oct 14 12:00 PDT.*

**Why a new repo and not a directory in `heddle`**
- Judges get a focused repo with its own README and run instructions.
- It needs no Rust toolchain and no heddle workspace build.
- It is independent of heddle's release train and CI.
- Its licensing is clean, with no weft anywhere in the dependency graph.

**Heddle dependency: the published 0.30.0 release, never unmerged code.**
- The engine image downloads the signed GitHub release binary for **v0.30.0** and checks its sha256.
- **Required action (Track E, Sat by 18:00 PDT):** tag `v0.30.0` at `878fea43` (already the release commit on main) and run `release.yml` to produce binaries. No code change.
- *Fallback:* a multi-stage Dockerfile running `cargo install --locked --git https://github.com/HeddleCo/heddle --tag v0.30.0 heddle-cli`, about 10–15 min per build and cached in the image.
- *Optional:* `cargo publish -p heddle-cli` at 0.30.0, so `cargo install heddle-cli --version 0.30.0` works.

**Heddle crate changes.**
- **None planned.** If a gate (G1–G3) needs a fix, it must be under about 50 lines.
- It lands on heddle `main` through the normal PR flow, is released as **0.30.1** by release-plz by **Mon Oct 12 18:00 PDT**, and the engine bumps its pin.
- Otherwise the named fallback ships.
- No Rust code lives in `heddle-artifacts`.

**Layout**
```
heddle-artifacts/
  LICENSE  NOTICE  README.md (try-it + self-deploy + local mode)  wrangler.jsonc  package.json (npm workspaces)
  contracts/   types.ts, engine.schema.json, events.ts       ← §7, written hour 0, owned by Track A, frozen by Sun 12:00
  worker/      index.ts api.ts project-do.ts engine-client.ts artifacts.ts events.ts auth.ts   (Track A)
  ui/          static app (no build step or tiny Vite) served via Workers assets                     (Track C)
  reviewer/    reviewer.ts prompts/                                                               (Track D)
  engine/      Dockerfile engine.mjs lib/*.mjs test/e2e.sh fixtures/                              (Track B)
  cli/         ha.mjs  (join | status | why)                                                      (Track D)
  demo/        seed-project/ briefs/ scripted-agents/ run.sh reset.sh VIDEO.md                    (Track D)
  dev/         fake-artifacts/ (Node + git http-backend) engine-devserver.mjs                    (Track A)
  .github/workflows/ci.yml  (npm test, vitest-pool-workers, engine e2e in docker)
```
Every source file carries `// SPDX-License-Identifier: Apache-2.0`.

---

## 7. Contracts (the only coupling between tracks; build against stubs)

### 7.1 Domain types (`contracts/types.ts`)
```ts
export type AgentKind = "agent" | "human" | "reviewer";
export interface Agent { id: string; kind: AgentKind; displayName: string; publicKey: string /*hex ed25519*/;
  email?: string; sponsor?: boolean; address?: string /*frozen at enrollment; absent on older records*/;
  provider?: string; model?: string; }
export interface Lane { project: string; task: string; agent: string; forkRepo: string; forkRemote: string;
  laneThread: string /* task/<t>/<a> */; lastSeenSha?: string; status: "active"|"released"|"abandoned"; }
export interface Candidate { task: string; agent: string; state: string /*Heddle State id*/;
  sourceSha: string /*agent's commit*/; treeSha: string; parentSha: string; subject: string;
  diffstat: { files: number; insertions: number; deletions: number };
  tests?: { status: "pass"|"fail"|"error"|"skipped"; passed: number; failed: number; summary: string; durationMs: number };
  conflicts: Array<{ path: string; region?: string; with: string[] /*other agent ids*/ }>;
  signedBy: string /*pubkey hex*/; capturedAt: string; }
export interface Turn { id: string; task: string; author: string; kind: AgentKind; body: string; replyTo?: string;
  heddleDiscussion: string; signedBy: string; at: string; }
export interface Decision { task: string; decider: string; pick: string /*agent id*/; rationale: string;
  alternatives: string[]; resolutionState: string; landState: string; mainSha: string; at: string; }
export type FeedEvent =
  | { type: "push.received"; task: string; agent: string; sha: string; via: "event"|"poll" }
  | { type: "candidate.ready"; candidate: Candidate }
  | { type: "tests.done"; task: string; agent: string; tests: Candidate["tests"] }
  | { type: "review.posted"; turn: Turn; review: Review }
  | { type: "discussion.posted"; turn: Turn }
  | { type: "decision.landed"; decision: Decision }
  | { type: "engine.error"; op: string; code: string; message: string };
export interface Review { summary: string;
  perCandidate: Array<{ agent: string; verdict: "approve"|"concerns"; notes: string }>;
  recommendation?: { pick: string; why: string }; model: string; }
```

### 7.2 HTTP API (Track A serves it; C and D consume it)
Auth:
- `Authorization: Bearer <OPERATOR_TOKEN>` (a Worker secret) for operator routes.
- `Bearer <agentKey>` for agent routes. Agent keys are random 32-byte values; ProjectDO stores only the SHA-256.
- The UI sets an HttpOnly cookie from a `/login` form that takes the operator token.

| Method and path | Auth | Request → Response |
|---|---|---|
| `POST /api/projects` | op | `{id, seed:{template:"demo"}\|{importUrl}}` → `{id, canonicalRemote, readToken}` |
| `POST /api/projects/:p/tasks` | op | `{slug, intent}` → `{slug, thread, baseSha}` |
| `POST /api/projects/:p/tasks/:t/agents` | op | `{id, kind, displayName, provider?, model?}` → `{agentKey, fork:{remote, token, expiresAt}, upstream:{remote, readToken}, setup: string /*sh script*/}` |
| `POST /api/projects/:p/humans` | op | `{id, displayName, email?, sponsor?}` → `{id, publicKey}` (decider and discussant identities) |
| `GET /api/projects/:p` | op/agent | `{project, agents, tasks:[{slug,intent,status,lanes,candidates,decision?}]}` |
| `GET /api/projects/:p/tasks/:t` | op/agent | `{task, candidates: Candidate[], turns: Turn[], review?: Review, decision?: Decision, heads: string[]}` |
| `GET /api/projects/:p/tasks/:t/candidates/:a/diff` | op/agent | `text/x-diff` (vs task base, max 512 KB) |
| `POST /api/projects/:p/tasks/:t/turns` | op/agent | `{body, replyTo?, as?}` → `Turn` |
| `POST /api/projects/:p/tasks/:t/decision` | op | `{pick, rationale, decider, expectHeads: string[]}` → `Decision`, or 409 `{error:"stale", heads}` |
| `POST /api/projects/:p/agents/:a/token` | agent | `{}` → a new fork token (refresh) |
| `GET /api/projects/:p/why/:sha` | public* | `{sha, narrative, decision?, candidate?}` |
| `GET /api/projects/:p/ws` | op/agent | WebSocket of `FeedEvent` JSON |
| `POST /__dev/events` | dev only | an Artifacts event JSON (the fake-artifacts hook posts here); 404 unless `env.DEV === "1"` |

\*Public only for the demo project. It is read-only and contains no tokens.

Human real emails are immutable. `sponsor: true` requires an email (otherwise
400 `invalid_sponsor`), and a project can designate only one human sponsor
(a different sponsor returns 409 `sponsor_exists`). The designation is durable.
New agents and reviewers receive `<local>+<agent-id>@<domain>` under that sponsor,
dropping any existing `+tag` from the sponsor's local part. New identities without
a real address use `<id>@noreply.heddle.sh`; the deployment variable
`ACTOR_EMAIL_DOMAIN` overrides this domain and must be a hostname with a dot.
The engine freezes addresses at enrollment. Existing records without `address`
continue using their human email or `<id>@heddle-artifacts.local`, without migration.

### 7.3 Engine contract (Track A calls it; Track B implements it)
- **Invocation:** `container.exec(["engine", <cmd>], { stdin: JSON | byte stream, env })`.
- **stdout:** exactly one JSON line.
- **stderr:** logs, which must never contain tokens.
- **Exit codes:** `0` ok. `2` domain rejection, with `{"error":{"code","message"}}`. `1` crash; ProjectDO retries up to 3 times with backoff and then emits `engine.error`.
- **Idempotency:** every mutating command takes `opId`. A replay with the same `opId` returns the recorded result.
- **Tokens:** passed only through `env` (`ARTIFACTS_READ_TOKENS` JSON map of remote → token, `ARTIFACTS_WRITE_TOKEN`), with a 10-min TTL, and used via `git -c http.extraHeader=…`. They are never written to disk.
- **Identity defaults:** `ACTOR_EMAIL_DOMAIN` is passed in `env` through `x-engine-env`; an invalid value rejects with `invalid_actor_email_domain` before writes. See `wrangler.example.jsonc`.

| cmd | stdin | stdout |
|---|---|---|
| `restore` | tar.zst bytes | `{generation}` |
| `snapshot` | `{}` | tar.zst bytes (ProjectDO streams them to R2) |
| `init` | `{opId, project, canonical:{remote}, seed}` | `{mainState, mainSha}` |
| `task.create` | `{opId, task, intent}` | `{thread, baseState, baseSha}` |
| `agent.enroll` | `{opId, agent: Agent-without-publicKey-or-address}` | `{publicKey, address?}` (address absent for older records) |
| `lane.open` | `{opId, task, agent}` | `{laneThread, leaseId}` |
| `ingest` | `{opId, items:[{task, agent, fork:{remote}, ref, sha}], runTests: boolean}` | `{results:[{agent, task, status:"captured"\|"duplicate"\|"rejected", candidate?: Candidate, reason?}], conflicts: {[task]: Candidate["conflicts"]}}` |
| `candidates` | `{task}` | `{heads: string[], candidates: Candidate[]}` |
| `diff` | `{task, agent, maxBytes}` | `{diff}` |
| `discuss` | `{opId, task, author, body, replyTo?}` | `Turn` |
| `decide` | `{opId, task, decider, pick, rationale, expectHeads}` | `Decision` (`mainSha` filled after publish) or exit 2 `stale` |
| `publish` | `{opId, canonical:{remote}}` | `{main, pushed: string[], verify:{exportRoundTrip, treeMatch, fsck}}` |
| `why` | `{sha}` | `{narrative}` |
| `selftest` | `{}` | `{heddleVersion, gitVersion, ok}` |

**`refs/notes/heddle-why` narrative format.** Plain text, stable, and parsed by nothing.
```
Heddle decision · task parser-escapes
Intent:    Support escaped pipes (\|) inside table cells
Chosen:    bob   3f2a91c  tests 14/14  signed ed25519:ab12…  (claude-code / sonnet)
Rejected:  alice 9c1e07d  tests 12/14  signed ed25519:77fe…  conflicts: src/table.ts:parseRow
Review:    reviewer (workers-ai/qwen-coder): alice changes the public API; bob keeps it.
Discussion: luke: agree — API stability matters more than the shorter regex.
Decided by luke ed25519:c0de… · resolution <state> · land <state>
```

### 7.4 Events and reviewer
- **Queue message.** The Artifacts event JSON, exactly as documented. ProjectDO consumes only `type == "cf.artifacts.repo.pushed"` with `payload.ref == "refs/heads/main"`, and routes on `source.repoName`.
- **Reviewer.** `review(input: {intent, base, candidates: Array<{agent, diff, tests}>, turns: Turn[]}): Promise<Review>`. Track D implements it; Track A calls it from ProjectDO after `candidate.ready`, debounced 5 s.

---

## 8. Work split (5 tracks)

### Rules common to all tracks (put these in every brief)
- **Repo and branches.** Work only in your own worktree and branch of `HeddleCo/heddle-artifacts`, and open PRs against `main`.
- **Off-limits.** Do not touch other tracks' directories except `contracts/`, which changes only by a PR that the Track A lead approves. Never edit heddle, weft or api. No destructive git. Never merge, approve or close PRs.
- **No weft.** No weft imports, URLs or biscuits.
- **Licensing.** Apache-2.0 SPDX headers on every file.
- **Secrets.** Never log or commit tokens. Real Cloudflare credentials stay outside agent sandboxes. Deploys are run by Track A's lead or the orchestrator.
- **Evidence.** Exact command output, plus proof that each acceptance test can fail: revert the fix and show the failure.
- **When blocked,** report and push nothing. Do not invent a workaround around a gate; the gate's named fallback is the workaround.

### Track A: Edge control plane (Worker, ProjectDO, Artifacts, Queue, R2), about 16 h, `high`
**Scope**
- `wrangler.jsonc` with these bindings:
  - Artifacts `ARTIFACTS` (namespace `heddle-demo`);
  - DO `PROJECT` (SQLite);
  - Container `ENGINE` (class `HeddleEngine`, image `./engine/Dockerfile`, root build context with a strict runtime allowlist, `standard-1`, `max_instances: 1`, five-minute idle timeout for the bounded single-project demo);
  - Queue producer and consumer `artifacts-events`;
  - R2 `STATE`;
  - `AI`;
  - assets `./ui`;
  - secrets `OPERATOR_TOKEN` and `CF_EVENTS_API_TOKEN`.
- The API in §7.2, with auth.
- ProjectDO SQLite schema: `agents, lanes, tasks, candidates, turns, decisions, pushes, ops, meta`.
- The engine client: a serialized queue with coalescing, a retry policy, and snapshot/restore streaming to R2 with generation compare-and-swap.
- Per-fork event subscription creation through the REST API at enrollment, plus the alarm poller fallback (3 s while active, off when idle).
- WebSocket hub using hibernatable WebSockets.
- `dev/fake-artifacts`, the **hour-0 deliverable**:
  - a Node smart-HTTP server over `git http-backend` with token checks (scope and TTL);
  - `create`/`fork`/`get`/`info`/`log`/`createToken`/`revokeToken` exposed as a JS object with the binding's shape (`FakeArtifacts`);
  - a post-receive hook that POSTs `cf.artifacts.repo.pushed`-shaped JSON to `/__dev/events`.
- `dev/engine-devserver.mjs`, which runs `engine` on the host so a Docker container is optional.

**Interfaces.** Provides §7.2 and §7.4 (consumes `review`). Consumes §7.3, against a stub engine that returns fixtures from `engine/fixtures/*.json` until Track B lands.

**Acceptance**
- **A-S1 live smoke on the real account** (first hour after the account is live), `scripts/smoke-artifacts.sh`:
  - create, fork, mint token;
  - stage pinned candidates, why notes and a recoverable directory manifest, verify exact OIDs, then advance only `main` with expected-old CAS;
  - prove stale CAS rejection and fresh mirror clone with strict fsck, exact refs/history/notes and a final remote readback;
  - the exact landed main's `pushed` event arrives in the Queue; retain phase timings and label one observation as such, not a latency percentile.

  Write the results to `docs/SMOKE.md`. **Notes rejected → switch to the §9 fallback R1 immediately.**
- **A-T1:** enrollment is idempotent and creates the fork name `p--t--a` (truncated and hashed if over the length limit).
- **A-T2:** a duplicate event plus a poll for the same `(lane, sha)` produces exactly one ingest op.
- **A-T3:** five concurrent `notePush` calls produce one or two engine execs (coalesced), all five captured, no 429.
- **A-T4:** decision without the operator token returns 403; mismatched `expectHeads` returns 409.
- **A-T5:** killing the container mid-op means the restore from the latest R2 generation and replay of the journaled op produce the same result.
- **A-T6:** the full F1–F5 flow on `wrangler dev` with fake-artifacts and the real engine via engine-devserver.

Tests run on `@cloudflare/vitest-pool-workers`.

**Local development before account access.** `wrangler dev` with `DEV=1` swaps in `FakeArtifacts` and posts events to `/__dev/events`. Once the account exists, set `remote: true` on the Artifacts binding to use the real service from `wrangler dev`, which needs wrangler ≥4.145; the box has 4.149. Containers run locally in Docker, or are bypassed with engine-devserver.

### Track B: Heddle engine (container), about 20 h, `xhigh` (critical path)
**Scope**
- `engine/Dockerfile`:
  - base debian trixie-slim with git ≥2.45, node 22, zstd and tar;
  - the heddle v0.30.0 binary, sha256-checked;
  - non-root user.
- `engine.mjs`, implementing every §7.3 command over the Heddle CLI with `--output json`.
- The `/state` layout: `repo/`, `lanes/<t>/<a>/`, `agents/<id>/home/`, `export.git`, `ops.jsonl`.
- Test runner: only complete operator-reviewed fixture trees may run `npm test --silent`, with a 60 s total timeout, in a fresh copy of verified source bytes. Native metadata and candidate `node_modules` are never copied. Unknown or changed trees return `Tests withheld:` before execution. The operator-owned locked npm cache can be prewarmed; user/global npm configuration is isolated. This fixture allowlist is not an untrusted-code sandbox.
- The `heddle-why` notes writer and the publish/verify steps from §4.3.

**Gates, spiked first. Each gate's result goes into `engine/GATES.md` with commands and output.**

| Gate | Due (PDT) | Must show | Fallback |
|---|---|---|---|
| **G1** | Sun Oct 11 10:00 | Per-agent identity: a capture signed by a hand-written `device-identity.toml` in per-agent `HEDDLE_HOME`, offline | The two fallbacks in §3 |
| **G2** | Sun Oct 11 12:00 | Lanes and candidates: (a) `agent fanout start` creates two lanes; (b) `agent reserve` and `agent capture --token` on each; (c) integrating two overlapping lanes produces a conflicted State with attributed candidates, and `resolve --heads` lists them and `resolve --pick` resolves them | (b2) lanes as candidates without the ADR-0053 path: decide with `heddle thread absorb <chosen>` and release/abandon the losers. Conflicts are computed with `git merge-tree --write-tree` on the lane projections and shown as `conflicts[]`. |
| **G3** | Sun Oct 11 14:00 | Projection: `heddle git import` of seed `main`, then capture/land, then `heddle git export` twice from a restored snapshot gives identical SHAs; `refs/notes/heddle` and trailers are present | `git commit-tree` builds the landing commit from the Heddle-landed tree with fixed identity and dates, and its message carries `Heddle-State` of the Heddle land. The landing is still performed in Heddle; Git only mirrors it. |

**Interfaces.** Implements §7.3 and the §4 ref layout and notes format. It runs standalone: `node engine.mjs <cmd>` on any Linux host with heddle and git, which is how Track A's devserver uses it.

**Acceptance (`engine/test/e2e.sh`, local bare repos only, no Cloudflare)**
- **B-T1.** Run init, task A (`parser-escapes`) and task B (`docs-readme`), and enroll alice, bob, carol, reviewer and luke. Then ingest three pushes **in one batch**: alice and bob both change `src/table.ts:parseRow`, and carol works on task B. Expect:
  - task A has two candidates with `conflicts[0].with` cross-referencing each other;
  - task B has one clean candidate.
- **B-T2.** Each candidate's `signedBy` equals its agent's enrolled key, as checked through `heddle show --output json`.
  - *Negative 1:* ingest an item that claims agent bob but comes from alice's fork remote. Expect a rejection with code `lane_mismatch`.
  - *Negative 2:* capture without the lease token fails.
- **B-T3.** `decide{pick:"bob"}` then `publish`. Expect:
  - every check in §4.3 holds (round-trip SHA, tree match, fsck, and candidates equal the original SHAs);
  - `git log --notes='heddle*' -1 main` contains "Chosen: bob" and "Rejected: alice".
- **B-T4.** `decide` with stale `expectHeads` exits 2 with `stale`, and the repo is unchanged.
- **B-T5.** Run `snapshot`, then `restore` in a fresh dir; `candidates` output is byte-identical.
- **B-T6.** Prove the tests can fail: disable the lease or identity check and B-T2 fails; skip the export pin and B-T3's round trip fails.
- **Docker.** `docker build` produces an image under 400 MB, and `engine selftest` prints the versions.

**Local development.** Entirely local: bare repos stand in for Artifacts (any `file://` or fake-artifacts URL). No account is needed until A-S1 passes.

### Track C: Decision UX (board, compare, decide, why), about 12 h, `high`
**Scope.** Static UI served by the Worker, written in plain TS with Preact or htmx and no heavy build. It has three screens:
1. **Project board** `/p/:p`.
   - Tasks as columns, lanes as cards (agent, model, last push, test badge). Cards update live from the WebSocket feed: push pulses, a candidate becomes ready, tests go green or red.
2. **Compare and decide** `/p/:p/t/:t`.
   - 2–3 candidates side by side: diff vs base, tests, diffstat, signature fingerprint and provenance.
   - Conflict regions highlighted, with the candidates for each region shown together.
   - The reviewer card with its recommendation.
   - The discussion thread, where the human can post.
   - A decision panel with a radio choice, a required rationale textarea and a "Land" button. The button sends `expectHeads`; on 409 it shows "Candidates changed, review again".
3. **Why** `/p/:p/why/:sha`.
   - The rendered narrative.
   - A copy-paste block with the exact `git clone` / `git log --notes='heddle*'` commands.
   - A "verified byte-exact" panel showing the `verify` result.

Also a `/login` page for the operator token. The layout must be legible at 1280×720 for recording, in dark and light, and keyboard accessible.

**Interfaces.** Consumes §7.1 and §7.2 only.

**Acceptance**
- **C-T1:** the three screens render from `ui/fixtures/{pushing,conflict,decided}.json`.
- **C-T2:** a scripted WebSocket replay (`ui/fixtures/feed.jsonl`) animates the board with no reload.
- **C-T3:** the decide form posts the exact §7.2 body and handles 200, 403 and 409.
- **C-T4:** Playwright smoke against `wrangler dev` covering board, compare, decide and why, with screenshots in the PR.
- Visual QA by the owner on Mon evening.

**Local development.** Fixtures plus a tiny mock server (`ui/dev-server.mjs`) until Track A's `wrangler dev` is up on Sunday afternoon.

### Track D: Agents, reviewer, CLI and demo harness, about 14 h, `high`
**Scope**
- **`demo/seed-project`.** A tiny TypeScript library, a Markdown-table parser, with vitest tests (under 5 s) and two prepared tasks:
  - `parser-escapes`, which deliberately invites conflicting edits to `parseRow`;
  - `docs-readme`, independent.
- **`demo/briefs/*.md`.** The agent briefs.
- **`demo/scripted-agents/`.** Deterministic agents that apply prepared commits with realistic timing, using plain `git` only. This is the **guaranteed path for the recording**.
- **`demo/run.sh --mode scripted|live`.** `live` launches three real coding agents (Claude Code / Codex) in tmux panes, each in its own clone with the enrollment setup script.
- **`demo/reset.sh`.** Deletes and recreates the demo project.
- **`reviewer/reviewer.ts`.**
  - Workers AI (`env.AI.run`). Choose a current code model on Sunday and pin it.
  - A strict JSON schema with up to 2 retries.
  - A canned fallback when `env.AI` errors, labeled `model:"fallback"`.
- **`cli/ha.mjs`.**
  - `ha join <url> --task t --as a` runs the setup script and configures `origin`/`upstream` with Bearer headers.
  - `ha status` and `ha why <sha>`.
- **The README "Try it" section and `demo/VIDEO.md`**, with the shot list and narration (§9.3).

**Interfaces.** Consumes §7.2; implements `review` (§7.4); depends on the §4 Git surface for the video commands.

**Acceptance**
- **D-T1:** `run.sh --mode scripted` against a deployed URL completes the full storyline in under 4 minutes, twice in a row after `reset.sh`.
- **D-T2:** reviewer output validates against `Review` for three fixtures; when AI is forced to fail, the fallback works.
- **D-T3:** a fresh machine (a clean container) follows the README "Try it" and reaches `git log --notes='heddle*'` in under 10 minutes; the transcript is attached.
- **D-T4:** in `--mode live`, three real agents push concurrently and at least two produce a conflict on `parseRow`. Record it; this is the preferred video take.

**Local development.** Run everything against `wrangler dev` with fake-artifacts. The reviewer runs against a stubbed `env.AI` locally, with Workers AI `remote` bindings once the account exists.

### Track E: Account, release, integration and submission (owner and orchestrator), about 8 h
**Scope**
- Bring the Cloudflare account live (§10).
- Tag `v0.30.0` and run the release binaries workflow.
- Create the repo with LICENSE, skeleton and `contracts/` from §7, plus CI.
- Hold the deploy token and run deploys, or delegate them to the Track A lead outside sandboxes.
- Integrate PRs and run the dress rehearsals.
- Record and edit the video, publish the repo and submit the form.

**Acceptance**
- The account checklist in §10 is complete, with A-S1 green.
- The v0.30.0 release assets exist.
- The repo is public with LICENSE.
- Submission is confirmed by Wed 17:00 PDT.

---

## 9. Critical path, day plan, risks

### 9.1 Critical path
```
E: account live + v0.30.0 binaries ─┐
                                    ├─► A-S1 smoke (notes/candidates refs accepted? events?) ─┐
B: gates G1→G2→G3 (local) ──────────┘                                                         ├─► M1: real push→capture→candidate on CF
A: fake-artifacts + ProjectDO + engine client (local) ─────────────────────────────────────────┘        │
                                                         B: decide/publish + byte-exact ──► M2: decision lands on CF main
C: UI on fixtures ──► wired to live API ───────────────────────────────────────────────────────────────┤
D: seed + scripted agents + reviewer ──────────────────────────────────────────────────────────────────┴─► rehearsal ─► video ─► submit
```
**The account must be live by Sun Oct 11 10:00 PDT at the latest.** It is better live today by 18:00 PDT. Every day of slip comes straight out of rehearsal time.

### 9.2 Day plan (PDT; CEST = PDT + 9 h)

| When | Milestone and owner |
|---|---|
| **Sat Oct 10 12:00** | Kickoff. E creates the repo, skeleton and `contracts/`. A starts fake-artifacts (hour 0). B starts G1. C starts on fixtures. D starts the seed project and scripted agents. |
| Sat 18:00 | **E:** account live (Workers Paid, Artifacts beta enabled, tokens per §10), v0.30.0 tagged with binaries. **A:** fake-artifacts plus ProjectDO skeleton. |
| **Sun Oct 11 10:00** | **G1** decided. **A-S1** live smoke done; fallback R1 triggered if needed. |
| Sun 12:00 | **G2** decided. **Contracts frozen.** C switches to `wrangler dev`. |
| Sun 14:00 | **G3** decided. Engine image builds; first Cloudflare deploy of Worker and DO with the stub engine. |
| **Sun 22:00** | **M1:** a real push to a real fork becomes a signed capture and a candidate ref on canonical, on Cloudflare. |
| Mon Oct 12 12:00 | Reviewer live; discussion turns signed. UI wired to live data. |
| **Mon 18:00** | **M2:** decision lands on Cloudflare `main` with notes; §4.3 verify is green. Heddle 0.30.1 cutoff, if any fix is needed. |
| Mon 20:00 | **Scope checkpoint.** If M2 is not met, cut to the MVC (§9.4) with no further debate. |
| **Tue Oct 13 10:00** | **Dress rehearsal 1**, scripted mode, full eight minutes, timed. Bug bash follows. |
| Tue 16:00 | **Dress rehearsal 2**, live agents. README "Try it" verified on a clean machine (D-T3). |
| **Tue 20:00** | **Code freeze.** Video recording 20:00–23:00, live take plus scripted backup take. |
| **Wed Oct 14 12:00** | Final take or pickups done. Editing done by 15:00. Repo public, `v1.0.0-competition` tagged. |
| **Wed 17:00** | **Submit.** That leaves 7 h of buffer before 23:59 PDT. |

### 9.3 Video storyline (8 min)
1. **(0:00–0:45) The problem.** Agents fight over one branch; the loser's work and reasoning vanish.
2. **(0:45–1:45) Setup.** One `POST` creates the project. The board shows three agents enrolled. Each gets its own Artifacts fork, and the clip shows a terminal running `ha join`.
3. **(1:45–3:15) Concurrent work.** Three tmux panes with three agents pushing at the same time (plain `git push`). The board pulses. Candidates appear with tests; carol's docs task is clean.
4. **(3:15–4:45) Conflict as candidates.** Alice and Bob both changed `parseRow`. The compare view shows the attributed candidates side by side, with signatures, models and test results.
5. **(4:45–6:00) Review.** The reviewer agent posts a recommendation; the human replies in the thread. All turns are signed.
6. **(6:00–7:00) Decide.** Pick Bob, write the rationale, press Land. `main` updates live.
7. **(7:00–8:00) Proof in plain Git.**
   - A fresh `git clone` and `git log --notes='heddle*'` show the why.
   - `git branch -r` shows the rejected alternative.
   - The tree-hash equality and `fsck --strict` pass on screen.
   - Close: "Artifacts holds the Git. Heddle holds the decisions."

### 9.4 Minimum viable cut (decided now; triggered at Mon 20:00 if M2 is missing)
**Keep**
- Worker, ProjectDO, Artifacts forks and tokens.
- Two or three **scripted** agents pushing concurrently.
- **Poll-only** ingest (no event subscriptions).
- Engine capture per agent lane with per-agent keys, or the G1 fallback 2 attestation.
- Candidates published as `candidates/<t>/<a>` with the exact SHAs.
- Server-rendered compare page: diffs, a conflict list from `git merge-tree`, and a rationale form.
- Decide, land in Heddle, `main` with the rationale and trailers, plus `refs/notes/heddle` and `refs/notes/heddle-why`.
- The §4.3 checks 1 and 3.

**Cut**
- The reviewer LLM (a human discussion turn replaces it).
- Tests per candidate.
- WebSockets (use a 2 s meta-refresh).
- `ha` CLI (use a README curl script).
- Live-agent mode, SSH-signed commits, WASM badges.

This still meets every hard requirement (Workers + Artifacts, concurrent multi-agent changes, Apache-2.0, video, run instructions) and still shows candidates and the why.

### 9.5 Risks and fallbacks

| # | Risk | Likelihood / impact | Detection | Fallback |
|---|---|---|---|---|
| R1 | Artifacts rejects `refs/notes/*` or non-branch refs, or non-fast-forward notes updates | Medium / high | A-S1, Sun 10:00 | Publish the why as a branch, `refs/heads/heddle/why`, holding `why/<sha>.md` files, keeping the in-message trailers. Use `git notes` only if accepted. For non-fast-forward: version notes commits on a parent chain (the engine reparents onto the remote notes tip before pushing). |
| R2 | Account or beta access late | Low-medium / **critical** (Artifacts is mandatory) | Sat 18:00 | Escalate to the owner immediately; everything is built locally against fake-artifacts. A late account compresses rehearsal, not build. Hard stop: if not live by Mon 12:00, go to the MVC. |
| R3 | `pushed` events are slow or unreliable, or per-repo subscription creation fails | Medium / low | A-S1 | The alarm poller (3 s) is always on while lanes are active. Ingest is idempotent, so both paths can run. |
| R4 | Heddle CLI gaps at G1, G2 or G3 | Medium / high | Sun 10:00–14:00 | The per-gate fallbacks above. A heddle fix only if it is under 50 lines and in 0.30.1 by Mon 18:00. **No unmerged Heddle code in the image, ever.** |
| R5 | Heddle in WASM | Settled | n/a | Not on the critical path. A Worker WASM verifier is only a stretch. |
| R6 | Container cold start or restore makes the first ingest slow | Medium / low | M1 | `setInactivityTimeout` of 2 h during demos, a warm-up `selftest` on project open, and snapshots under 10 MB for the demo repo |
| R7 | Live agents misbehave on camera | High / medium | Tue rehearsal | Scripted mode is the guaranteed take; the live take is a bonus. Briefs are tightly scoped. |
| R8 | Tokens leak in a video or logs | Low / high | Review | Bearer headers through `extraHeader` with no tokens in URLs; tokens redacted in UI and logs; demo tokens revoked after recording (`revokeToken`) |
| R9 | Time | High / high | Daily milestones | The pre-decided MVC at Mon 20:00, with no new scope after Sun 12:00 except MVC cuts |
| R10 | Eligibility and logistics (US/CA residency, 18+, one entry, live presentation Oct 21 SF) | Owner-confirmed eligible | n/a | The owner holds Oct 21 |

---

## 10. Account access needed (Track E, by Sat 18:00 PDT)

**Account setup**
- Use the existing **Heddle Cloudflare account** on the **Workers Paid** plan, which Artifacts and Containers require.
- Turn on Artifacts (open beta) in the dashboard under Workers → Artifacts.
- Create namespace `heddle-demo`.
- Use the default `*.workers.dev` subdomain; no custom domain is needed.

**Deploy token** (held by the orchestrator or Track A lead, outside agent sandboxes). Scoped to the Heddle account only.
- Account › **Workers Scripts: Edit** (Worker, Durable Objects, assets, secrets)
- Account › **Containers: Edit** (image push and the container application). Also add **Cloudchamber: Edit** if `wrangler containers` asks for it on that account.
- Account › **Artifacts: Edit** and **Artifacts: Read**
- Account › **Queues: Edit** (queue, consumer, event subscriptions)
- Account › **Workers R2 Storage: Edit**
- Account › **Workers AI: Read**
- Account › **Workers Tail: Read**
- Account › **Account Settings: Read**
- User › **User Details: Read**, **Memberships: Read** (for `wrangler whoami`)

**Runtime Worker secrets**
- **`CF_EVENTS_API_TOKEN`**, a second, narrow token with Account › **Queues: Edit** and **Artifacts: Read** only. Its sole use is creating `pushed` subscriptions per fork at enrollment.
- **`OPERATOR_TOKEN`**, 32 random bytes.

**Also from the owner**
- Confirm the repo visibility default (public from day 1).
- Hold Oct 21 for a possible finalist presentation.
- Provide the account ID for the README.
- Optional: an Anthropic or OpenAI key for live-mode agents. It stays local and is not a Cloudflare secret.
