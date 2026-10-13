<!-- SPDX-License-Identifier: Apache-2.0 -->
# Agent runner: coding agents in Cloudflare Sandboxes

Each live Heddle lane can run its coding agent (Codex, OpenCode or Claude Code) in its own Cloudflare
Sandbox instead of on an operator's machine. The control plane enrolls the lane and issues a
fork write token and a canonical read token. The harness hands that grant to this Worker, which:

1. starts a Container for the lane with **no direct Internet** (`enableInternet: false`);
2. routes all of the sandbox's HTTP/HTTPS through `Outbound` ([`src/policy.ts`](src/policy.ts)), which allows only
   - this account's Workers AI inference (`api.cloudflare.com/client/v4/accounts/<id>/ai/v1/…`), adding the token and
     `cf-aig-gateway-id` so requests are logged by the gateway and billed as Workers AI (standard billing),
   - this account's AI Gateway provider routes, for third-party models (Claude Code lanes), billed through the
     gateway's Unified Billing or a provider key stored in the gateway,
   - this lane's own Artifacts fork (write token added) and the canonical repo (read token added, pushes refused),
   - the npm registry, read-only and without credentials;
3. clones the fork, then runs the agent on the task brief. The agent tests, commits and runs `git push origin HEAD:main`.
   If the agent's run ends successfully but leaves uncommitted changes or unpushed commits, the lane gets exactly
   one follow-up turn in the same session (`opencode run --continue`, `claude --continue`) asking it to push or say
   why not. The sandbox is discarded afterwards, so this keeps finished work from being lost; the runner never
   commits or pushes on the agent's behalf.

A lane may name its model: a `cloudflare-workers-ai/@cf/…` id on an OpenCode lane, or a `claude-…` id on a Claude
Code lane (default `CLAUDE_MODEL`).

The push reaches the control plane like any other: Artifacts event → Queue → Durable Object → engine capture.
**No credential ever enters the sandbox.** The agent sees placeholder keys, and the Worker adds real ones per request.

## Deploy

1. Create an AI Gateway named `heddle-artifacts` with authentication on and Unified Billing credits loaded.
2. Create a Cloudflare API token with **AI Gateway Run**, plus a random `RUNNER_TOKEN`. Then:

```sh
cd agent-runner && npm ci
printf '{"AI_GATEWAY_TOKEN":"%s","RUNNER_TOKEN":"%s"}\n' "$AIG" "$RUNNER" > .secrets.json  # keep 0600
npx wrangler deploy --secrets-file .secrets.json && rm .secrets.json
```

Run lanes with `DEMO_LIVE_PROVIDERS=alice=cf-codex,bob=cf-claude ./demo/run.sh --mode live` (see `demo/README.md`).

## Tests

`npm test` covers the outbound policy: gateway token injection, fork/upstream scoping,
refusing upstream pushes, prefix look-alikes, plain HTTP, other hosts and the read-only npm registry.
`npm run typecheck` checks the Worker.

Adapted from Cloudflare's [sandbox-sdk coding-agents example](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/coding-agents) (Apache-2.0).
