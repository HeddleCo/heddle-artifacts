<!-- SPDX-License-Identifier: Apache-2.0 -->
# heddle-artifacts

Several coding agents work on the same task at once, each pushing plain `git` to its own Cloudflare Artifacts fork.
Overlapping pushes are kept side by side as **candidates**, with test results and an AI review, instead of being rejected.
A human picks one and writes why. The pick, the reason and the rejected alternatives land on `main` as Git notes.

![Compare-and-decide page: two agent candidates that changed the same function, their test results, and the decision form](docs/img/compare.png)

*The compare page, from the canned preview in [Try it (b)](#b-preview-the-ui-only-canned-data).*

## Built on Heddle

The engine is [Heddle](https://github.com/HeddleCo/heddle), our open-source (Apache-2.0) version control for agent
work. The engine Container builds the Heddle CLI from source at the 0.31.1 release commit
([`0b5eec4`](https://github.com/HeddleCo/heddle/commit/0b5eec40276510d2723a1572bdea0e9640e66e33), see
[`engine/Dockerfile`](engine/Dockerfile)) and runs it for every capture, merge, discussion, briefing and decision.
This repository is the platform around it on Cloudflare: agents push plain Git to Artifacts forks, and Workers,
Durable Objects, Queues, Containers and Sandboxes turn those pushes into Heddle candidates that are tested, reviewed and decided.

The same CLI also runs on your own machine:

```sh
cargo install --locked --git https://github.com/HeddleCo/heddle --rev 0b5eec40276510d2723a1572bdea0e9640e66e33 heddle-cli
```

## Try it

### (a) Run it yourself, on your own machine

One command starts the real stack locally: the Heddle engine, a git server standing in for Artifacts, the Worker and
the UI. You bring a repository and your own agents; nothing here is a canned example.

Needs Node 22+, Git, `tar`, `zstd`, a Rust toolchain, and the Heddle 0.31.1 CLI (the command checks and tells you exactly what is
missing; it never installs or builds Heddle for you, though it builds the UI itself the first time and whenever the UI sources are newer than the build).
On Debian/Ubuntu: `sudo apt-get install zstd`; on macOS: `brew install zstd`. Rust comes from <https://rustup.rs> (then `rustup default stable`).

Installing Heddle compiles it from source. The final link peaks at about 6 GB of memory, so have about 8 GB free (or swap)
and allow about 20 minutes. `CARGO_BUILD_JOBS=2` keeps the earlier steps from piling on top of that:

```sh
CARGO_BUILD_JOBS=2 cargo install --locked --git https://github.com/HeddleCo/heddle --rev 0b5eec40276510d2723a1572bdea0e9640e66e33 heddle-cli
git clone https://github.com/HeddleCo/heddle-artifacts.git && cd heddle-artifacts
npm ci && npm ci --prefix ui
node cli/up.mjs local
```

It prints a URL and where your operator token is stored (`cat` that file to sign in).
A local stack starts empty. To try the sample, pick **The sample project** in step 1, name it `demo`, and add a task such as `parser-escapes` in step 2. Then, in the app:

1. **Create a project**: from a public repository address, or the small sample project. Add a test command if it is
   not `npm test` (npm, npx and node only).
2. **Add a task**: say what the agents should try to do.
3. **Put your own agent on it**: the task page shows the exact `ha join …` command. Run it in a clone, point Claude
   Code, Codex, OpenCode or plain `git` at the folder, and `git push origin HEAD:main`.
4. Each push appears as a candidate with test results. Compare, write the reason, and land one.

What is different from the live deployment: candidate tests run on **your machine**, in a throwaway checkout, not in
an isolated Sandbox (the board says "local run (not isolated)"), and there is no AI reviewer unless you enrol one.
**Candidate code runs as you.** It can read your files, including the operator token, and it can interfere with other
candidates' results. Use this only for your own agents' work, never for code you do not trust. (A deployment on your
own Cloudflare account tests in a keyless Sandbox instead; see (c).) Up to two candidates are tested at a time; the rest
wait their turn. State lives in `~/.heddle-artifacts/local` (`--state DIR` to change, `--port N` to pin the port); Ctrl-C
stops everything, at any point.

Two `cli/ha.mjs` details: `node cli/ha.mjs why <sha>` needs the full 40-character commit SHA, and `join` also takes
`--provider` and `--model` (for example `--provider anthropic --model claude-code`); without them the Why page lists the agent as
`unknown / unknown`.

### (b) Preview the UI only (canned data)

No Heddle needed; this serves the UI against a fixture API with invented data, to look around or click through a decision:

```sh
cd heddle-artifacts/ui && npm ci && UI_FIXTURE=conflict npm run dev
```

Open <http://127.0.0.1:4173/p/demo/t/parser-escapes>. Port 4173 in use? Add `PORT=4174`. `UI_FIXTURE=pushing` plus
`curl -X POST http://127.0.0.1:4173/__mock/replay` replays a story onto the board; `UI_FIXTURE=decided` starts after the decision.
Deeper account-free checks are in [docs/LOCAL-INTEGRATION.md](docs/LOCAL-INTEGRATION.md) and [ui/README.md](ui/README.md).

### (c) Deploy your own

One command, on your own Cloudflare account (Workers Paid plan, Docker running, `npx wrangler login` done):

```sh
node cli/up.mjs cloudflare --name my-app        # shows the plan and asks first; add --dry-run to only look
```

It creates the R2 bucket and Queue, builds the engine and test-sandbox images locally, deploys the Worker, waits for it to
answer, and prints the URL and where your operator token is. Sign in with it and use the same forms as in (a): there,
candidate tests run in a keyless Cloudflare Sandbox, not on your machine. Nothing is public unless you pass
`--public-project NAME`; `--domain host.example.com` adds a custom domain. `--destroy` removes exactly what it created.
Details, and the manual steps it wraps, are in [docs/DEPLOY.md](docs/DEPLOY.md). Running agents in Cloudflare Sandboxes
(instead of your own agent CLIs) is an optional extra step there.

## Glossary

- **Lane:** one agent's line of work on one task. Each lane has its own Artifacts fork; the agent pushes there with ordinary Git.
- **Candidate:** the latest push in a lane, captured by the engine and signed with that agent's key. Candidates on
  the same task are compared side by side, with tests and a review. When two touch the same code, the overlap is shown, and both stay.
- **Decision:** a human picks one candidate and gives a reason. The decision is signed by that human and lands the
  chosen tree on `main`. The other candidates are recorded as rejected alternatives, not deleted.
- **Why / notes:** the record of a decision (intent, chosen and rejected candidates, test results, review, discussion,
  decider and reason). It is stored in Git as `refs/notes/heddle-why` on the landed commit, so a plain `git clone`
  plus `git fetch origin '+refs/notes/*:refs/notes/*'` carries it, and the Why page shows it.

## How it works

- Each agent pushes plain `git` to its own Artifacts fork. On the live app, agents run in Cloudflare Sandboxes
  through [`agent-runner/`](agent-runner/README.md); the sandbox has no direct Internet and holds no credentials.
- An Artifacts push event goes through a Queue to the project's Durable Object, which asks the Heddle engine
  (a Container) to capture the push as a signed candidate. Engine state is snapshotted to R2.
- Candidate tests run in separate Sandboxes that hold no keys. A Workers AI model (GLM-5.2) reviews the candidates.
- A human picks a candidate in the UI and gives a reason. The engine lands it on `main` with `Heddle-State` /
  `Heddle-Change` trailers and attaches the why note. `demo/run.sh verify` checks the result from a fresh clone.
- The reason carries forward. The decision's reason becomes a Heddle annotation on the code it chose. When a later
  agent opens a lane, Heddle gives it a signed briefing with those annotations (`heddle context --for-thread`).
  The compare page's **Context supplied** panel shows exactly what each agent was told. `demo/run.sh followup`
  runs this end to end.

Cloudflare products used: Workers, Durable Objects, Artifacts, Queues, Containers, Sandboxes, R2, Workers AI and AI Gateway.
Design details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Caveats

- This is a competition entry for Cloudflare's "Build the next Git platform", under active development.
- Keys are custodial: the engine holds one signing key per agent, human and reviewer. Git author fields alone are
  not trusted identities.
- The engine runs tests only for whole trees on a reviewed allowlist. Other candidates are tested in a separate
  Sandbox with no keys, Worker bindings or write tokens ([details](docs/isolated-candidate-tests.md)). Test counts
  come from candidate-authored tests, so they can still misrepresent correctness; the review looks at the diff too.
- Artifacts rejected atomic multi-ref push, so publication updates `main` last, after verifying the other refs.
  Auxiliary refs may be briefly pending; there is no all-refs-atomic view.
- The UI preview in (b) uses canned data. Its Why page shows the fixture narrative, not the reason you typed.
- Live compatibility evidence is in [docs/LIVE-ARTIFACTS-20261010.md](docs/LIVE-ARTIFACTS-20261010.md).

## Run the storyline against a deployment

Requires Node 22+, Git, the deployment's HTTPS Worker URL and its operator token. No Heddle install is needed.

```sh
git clone https://github.com/HeddleCo/heddle-artifacts.git
cd heddle-artifacts
# Load OPERATOR_TOKEN securely in this shell. Do not paste it into a URL or video.
export DEMO_URL=https://your-worker.workers.dev
export DEMO_PROJECT=demo
export DEMO_DIR=/tmp/heddle-try-it
./demo/run.sh --mode scripted
```

This creates two tasks, enrolls three agents in independent forks, pushes their prepared commits concurrently,
waits for conflict candidates and a signed review, records a clearly scripted discussion and decision under the
demo human identity, then prints `git log --notes='heddle*'` from a fresh clone. It fails if candidate SHAs
change, the chosen tree differs, Git objects fail strict validation, the decision is stale, or the chosen/rejected
notes disappear. `--mode live` runs real coding agents instead. See [demo/README.md](demo/README.md) for reset,
live mode and local testing. A second take needs the operator's cleanup command, because the API has no
project-delete route.

Prepared parser candidates have 18 tests: Bob passes; Alice fails the escape edge cases. Carol's independent
documentation candidate passes the 14 baseline tests.

### Join the docs task from your own clone

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

Bearer headers are scoped to the fork and canonical URLs, stored in private `.git` files, and never embedded in
remote URLs. Do not print Git config on camera.

## License

Apache-2.0. See [LICENSE](LICENSE).
