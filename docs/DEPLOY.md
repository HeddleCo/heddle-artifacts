<!-- SPDX-License-Identifier: Apache-2.0 -->
# Deploy your own

## The one-command way

```sh
npm ci && npm ci --prefix ui
npx wrangler login
node cli/up.mjs cloudflare --name my-app
```

It shows what it will create and asks before doing anything (`--dry-run` only looks, `--yes` skips the question). It then creates the
R2 bucket `my-app-state` and Queue `my-app-events` (safe to re-run), builds the UI, writes a git-ignored `wrangler.live.up-my-app.json`,
generates an operator token into `~/.heddle-artifacts/cloudflare/my-app/operator-token` (mode 0600, never on a command line), deploys, and
waits for the Worker to answer. A first deploy builds the engine image from Heddle source: up to about 30 minutes on a clean Docker cache,
a few minutes if the layers are cached.

Options: `--domain host.example.com` (custom domain on a zone in the same account), `--public-project NAME` (make one project readable by
anyone, as on the public demo; otherwise nothing is public), `--namespace NS` (Artifacts namespace; default is the name), `--account ID`
(when your login has several accounts), `--state DIR`.

`node cli/up.mjs cloudflare --name my-app --destroy` removes the Worker, its containers, the Queue and the bucket, and only those it
recorded creating. Wrangler cannot list or empty an R2 bucket, so a bucket that still holds data is given a one-day expiry rule and
removed by running the same command again after 24 hours. Artifacts repositories in the namespace are not removed (delete them with
`wrangler artifacts repos delete`).

The steps below are what it wraps, for doing it by hand.

These are the steps used for the live deployment, with your own names. You need a Cloudflare account on
the Workers Paid plan (Containers and Sandboxes), Node 22+, Docker running locally, and `npx wrangler login`.

## 1. Build

```sh
git clone https://github.com/HeddleCo/heddle-artifacts.git && cd heddle-artifacts
npm ci && npm ci --prefix reviewer && npm ci --prefix ui
npm run build   # builds ui/dist
```

## 2. Create the Cloudflare resources

```sh
npx wrangler r2 bucket create heddle-artifacts-state
npx wrangler queues create artifacts-events
npx wrangler queues info artifacts-events     # note the Queue ID
npx wrangler artifacts namespaces list        # the namespace named in wrangler.jsonc
```

`wrangler.jsonc` binds the Artifacts namespace `heddle-demo`. You do not need to create it first: Artifacts creates a namespace
automatically the first time a repository is created under it. Use your own name (set the same name in `artifacts[0].namespace`
and `vars.ARTIFACTS_NAMESPACE`) rather than sharing another deployment's.

## 3. Configure

Copy `wrangler.jsonc` to `wrangler.live.jsonc` (git-ignored; never commit account data) and set:

- `account_id`: your account ID;
- `vars.CF_ACCOUNT_ID`: the same account ID;
- `vars.EVENTS_QUEUE_ID`: the Queue ID from step 2;
- `vars.DEMO_CREDENTIAL_TTL_SECONDS`: how long a project accepts work, 120–14400 seconds (default 3600);
- `workers_dev: true`, if you want a `*.workers.dev` URL;
- `containers[0].max_instances`: about 10. Each project uses its own engine container while active.

Secrets:

- `OPERATOR_TOKEN`: a long random string; it signs operators in.
- `CF_EVENTS_API_TOKEN`: an API token that can create Artifacts event subscriptions to your Queue, so pushes
  arrive as events. Without it, pushes are still picked up by the 3-second fork poll.

```sh
printf '{"OPERATOR_TOKEN":"%s","CF_EVENTS_API_TOKEN":"%s"}' "$OPERATOR_TOKEN" "$EVENTS_TOKEN" > .secrets.json   # chmod 600
npx wrangler deploy --config wrangler.live.jsonc --secrets-file .secrets.json && rm .secrets.json
```

The first deploy builds the engine image from source (`engine/Dockerfile` compiles the pinned public Heddle
CLI): up to about 30 minutes on a clean Docker cache. `engine/Dockerfile.layer` is not for a fresh account: it starts from an image
pinned in the Heddle account's own registry. It only suits someone who has pushed their own verified engine image and edits its `FROM`.

### Optional: a custom domain

If the domain's DNS is on the same Cloudflare account, add one line to `wrangler.live.jsonc` and deploy again; Cloudflare
creates the DNS record and certificate:

```jsonc
"routes": [{ "pattern": "demo.example.com", "custom_domain": true }]
```

The Worker is then served at both that name and `*.workers.dev`. Do not use a name that already has a DNS record.

## 4. Check it

```sh
export OPERATOR_TOKEN DEMO_URL=https://<your-worker>.workers.dev
./demo/run.sh --mode scripted --url "$DEMO_URL" --project smoke --dir /tmp/heddle-smoke
```

This creates a project, enrolls three scripted agents, pushes their prepared commits concurrently, waits for
tests and review, records a decision, and proves the result from a fresh clone. A project's first request
starts its engine container (10–60 s).

Operator diagnostics for a project: `GET /api/projects/<project>/diagnostics` with the operator bearer.
To close a project and revoke its tokens: `POST /api/projects/<project>/cleanup`.

## 5. Live agents in Cloudflare Sandboxes (optional)

`agent-runner/` is a separate Worker that runs Codex, OpenCode or Claude Code lanes in Sandboxes on Workers AI.
See [agent-runner/README.md](../agent-runner/README.md) for its gateway token and deploy. Then:

```sh
DEMO_LIVE_PROVIDERS=alice=cf-opencode,bob=cf-opencode,carol=cf-opencode \
DEMO_LIVE_MODELS=alice=@cf/qwen/qwen3.8-27b,bob=@cf/moonshotai/kimi-k2.7-code,carol=@cf/moonshotai/kimi-k2.7-code \
DEMO_RUNNER_URL=https://<your-runner>.workers.dev DEMO_RUNNER_TOKEN_FILE=~/.runner-token \
./demo/run.sh --mode live --url "$DEMO_URL" --project live1 --dir /tmp/heddle-live1
```

After deciding in the UI, `./demo/run.sh verify …` proves the published result. `./demo/run.sh followup …` then
opens a follow-up task whose agent is briefed with the decision's rationale.
