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

Providers `cf-codex`, `cf-opencode` and `cf-claude` run that lane's agent in a Cloudflare Sandbox through
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

### Revision round

With `DEMO_REVISION_ROUND=1`, a live run whose lanes are `cf-*` gives each agent one more turn after the
review. The harness waits for each task's signed review of its current candidates and refuses the
fallback review, which no model wrote. Then it starts one new sandbox lane per agent with the same grant,
which it holds in memory only. Each brief is the original brief, the review summary, that agent's verdict
and notes, the recommendation, and the other agents' closing notes, quoted verbatim from the discussion.
The agent may revise and push, or keep its candidate and say why. Its closing turn begins with
"Revision:". A push becomes the lane's new head on the board, and it is tested and reviewed again. The
harness prints each agent's outcome. It writes the briefs, the before and after diffs, and `result.json`
to `<dir>/<generation>/revision-<n>/`. The round must finish inside the project's one-hour write window.

### Combined with main

`demo/run.sh combined` runs two sandbox agents on two tasks from the same main: erin's
`cell-whitespace` (cells keep their whitespace, so code tables keep their indentation) and finn's
`table-header` (a new `readTable(markdown)` returning `{ header, rows }`). The briefs are independent;
neither mentions the other task or a combined result. Once both candidates are tested alone, the
harness waits for the human to land erin's in the UI (`DEMO_COMBINED_AUTOLAND=1` lands it for a
rehearsal). Main has then moved past finn's base. The platform has Heddle merge finn's candidate with
the new main in a scratch thread, records Heddle's verdict, and tests the merged commit in an isolated
sandbox. The board shows, for example, "✓ 22/22 alone · ✕ 3 failing combined with main", and landing
finn is refused while it fails. If it fails, finn gets one more turn whose brief quotes the decision
that moved main (with its reason), the failing tests and the sandbox output, and points at the merged
commit (`refs/heads/combined/<task>/<agent>/<sha>` on the read-only upstream) to fast-forward to. Its
fixed push contains main, so its own tests are the combined result, and the human can land it. If the
merged result passes instead, the human can land Heddle's merge directly.

Why this pair breaks reliably: finn's new tests are written against the trimming parser finn started
from, so they expect `["Name", "Age"]`; erin's task removes that trimming, so on main the same table
reads `[" Name ", " Age "]`. finn adds a new function and a new test file, so the two edits do not
touch the same lines and merge cleanly; only running the tests on the merged result shows the break.
`demo/test/combined-scenario.test.mjs` checks this with representative implementations on the real
seed and its Vitest suite: each passes alone, the merge is clean, the merged code fails 3 tests.
`DEMO_COMBINED_AGENT` (`opencode`, `codex` or `claude`) and `DEMO_COMBINED_MODEL` pick the sandbox
agent; evidence is written to `<dir>/combined-<generation>/`.

## A real repository

The same platform runs on any public repository. `init` imports it as a new project with a test recipe
(how the isolated sandbox installs and tests candidates; set once by the operator, never by candidates),
and `task` puts several sandboxed agents on one task with one brief:

```bash
export OPERATOR_TOKEN=... DEMO_RUNNER_URL=https://<agent-runner>.workers.dev DEMO_RUNNER_TOKEN_FILE=~/.runner-token
DEMO_IMPORT_URL=https://github.com/pngwn/twinkleplop.git DEMO_TEST_RECIPE=@demo/recipes/twinkleplop.json \
  demo/run.sh init --url https://<worker>.workers.dev --project lua --dir /tmp/lua-demo
DEMO_TASK_SLUG=lua DEMO_TASK_INTENT='Add Lua 5.4 highlighting (twinkleplop#102)' \
DEMO_TASK_BRIEF=demo/briefs/twinkleplop-lua.md DEMO_LANE_MINUTES=90 \
DEMO_TASK_AGENTS=kimi=@cf/moonshotai/kimi-k2.7-code,glm=@cf/zai-org/glm-5.2 \
  demo/run.sh task --url https://<worker>.workers.dev --project lua --dir /tmp/lua-demo --timeout 6000
```

The project starts from the repository's tip as a single commit whose tree is the source tree exactly; its
message names the source URL and commit (set `DEMO_IMPORT_HISTORY=full` to import the whole history,
which Heddle 0.30 then re-exports on every publication). `demo/recipes/twinkleplop.json` is twinkleplop's own CI as a recipe: a frozen-lockfile pnpm install, the
theme build, `svelte-kit sync`, then `pnpm test`, within 600 seconds. The brief points the agents at the
repository's own grammar skills and carries the Lua 5.4 manual's lexical rules, since lanes reach only
the model, their fork and the npm registry. Each candidate is compared, reviewed and decided like the
parser's; Heddle's `bridge git export` turns the landed commit into an ordinary branch for a pull request.

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
