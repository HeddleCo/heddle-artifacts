<!-- SPDX-License-Identifier: Apache-2.0 -->
# Recording harness

`seed-project/` has 14 baseline Vitest tests, normally under a second. Alice's
prepared regex loses three escape edge cases; Bob's scanner passes all 18 tests.
Both replace `src/table.ts:parseRow` from the same base. Carol changes only the
README in `docs-readme`. Prepared sources and fixed Git identity/dates make the
agents deterministic for a fixed seed commit. Each agent sleeps eight seconds
then pushes directly with ordinary Git; no Heddle or API calls enter that path.

With the Worker/Artifacts deployment ready and an operator bearer already loaded:

```sh
export DEMO_URL=https://your-worker.workers.dev
export DEMO_PROJECT=demo
export DEMO_DIR=/tmp/heddle-recording
./demo/run.sh --mode scripted
```

The harness creates the project using `{seed:{template:"demo"}}`, the two tasks,
Luke, reviewer, and three coding agents. The engine demo template must contain
the contents of `demo/seed-project` at its repo root, including the lockfile and
Vitest dependency. Track B's lane test runner needs `npm ci` before `npm test`
on a fresh checkout. The harness waits for tests and signed review, posts Luke's
reply, decides with current `expectHeads`, then clones canonical and verifies
candidate SHA preservation, tree equality, strict fsck/index-pack, trailers,
notes and public why. Carol stays an unlanded independent candidate so choosing
Bob from the original base retains whole-tree equality. The engine's export
round-trip check remains Track B evidence and is not inferred by this harness.

`--url`, `--project`, `--dir`, `--timeout` (candidate/review wait, default 180 s)
and `--delay` (scripted think time, default 8 s) override defaults. The total
scripted run must stay under 240 s, independently of its polling timeout.
Successful runs write `<DEMO_DIR>/<generation>/result.json` with timings, SHAs
and checks. Credential-bearing `.demo.json` is mode 0600, outside the repo.
Clones and proof directories remain available for the recording. Reset before
each new take; never reuse an old clone against a recreated project.

## Reset contract gap

§7.2 has no deletion route. `reset.sh` therefore requires an owner-supplied
`DEMO_RESET_COMMAND`, executed with `DEMO_PROJECT`, `DEMO_URL` and the existing
operator environment. It must revoke tokens/subscriptions and remove the named
project's forks, canonical repo, DO metadata and R2 state. After it succeeds,
reset recreates the project/tasks/human/reviewer via the specified API. Failure
stops immediately. This command is trusted local configuration, never server data.
The script keeps old local clones for evidence; it creates a new generation
instead of deleting an arbitrary directory. Track A/E must supply production
cleanup at integration; no uncontracted DELETE endpoint is called.

## Live mode

Install/authenticate Codex or Claude Code locally, plus tmux. Optional
`DEMO_LIVE_MODEL` pins the actual CLI model and enrollment metadata;
`DEMO_LIVE_PROVIDER=codex|claude` defaults to Codex. Mix vendors per lane with
`DEMO_LIVE_PROVIDERS=alice=codex,bob=claude,carol=claude` and per-lane models with
`DEMO_LIVE_MODELS=alice=gpt-6.1-sol,bob=claude-opus-5-5`.

Providers `cf-codex` and `cf-claude` run that lane's agent in a Cloudflare Sandbox through
[`agent-runner/`](../agent-runner/README.md) instead of on this machine. Set `DEMO_RUNNER_URL`
to the runner's origin and `DEMO_RUNNER_TOKEN_FILE` to a 0600 file holding its bearer. The
lane's fork credentials go only to the runner Worker, never into the sandbox. Reset, then:

```sh
./demo/run.sh --mode live --timeout 600
# Attach to the session printed by the harness from a second terminal.
```

Three tmux panes start real noninteractive CLI agents in independent enrolled
clones. The [Codex command](https://learn.chatgpt.com/docs/non-interactive-mode)
uses workspace-write and network access for npm/Git. Claude uses acceptEdits
with Read/Edit/Write and scoped Git/npm tool permissions. The operator bearer is
cleared before agent launch. Terminal panes show start/finish markers; raw agent
output is suppressed to keep config/header dumps off camera. The board and Git
push timestamps supply recording evidence. If any agent fails, inspect its
private clone, reset, and use the named §9.5 R7 scripted fallback. Real live work
is not claimed by tests using stand-in executables.

## Independent local contract test

Until Track A's fake-artifacts plus wrangler and Track B's engine are available:

```sh
npm ci --prefix demo/seed-project
node --test cli/ha.test.mjs demo/test/storyline.test.mjs
node demo/test/reviewer-mutations.mjs
node demo/test/cli-mutations.mjs
node demo/test/parser-variants.mjs
```

`demo/test/mock-platform.mjs` uses real Git smart HTTP, fork-scoped Bearer checks,
real candidate tests and `git merge-tree` conflict detection. Only the §7.2 API
shape and engine keys/states/notes are simulated. It is test infrastructure, not
a replacement for Track A's fake-artifacts, Heddle signatures or the deployed
D-T1 check. `/__test/reset` exists only in this test double and is not an API proposal.

`npm test --prefix reviewer` uses a stubbed `env.AI`. Production Workers AI calls
and the clean real deployment take remain integration evidence. Negative tests
remove conflict data/notes or inject failing tests/stale heads and require the
precise storyline guard to reject them.
