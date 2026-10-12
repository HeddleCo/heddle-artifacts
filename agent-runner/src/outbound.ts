// SPDX-License-Identifier: Apache-2.0
// Adapted from cloudflare/sandbox-sdk examples/coding-agents/runner/outbound.ts (Apache-2.0).
import { WorkerEntrypoint } from "cloudflare:workers";

import { decide, type LaneGrant } from "./policy";
import type { RunnerEnv } from "./lane";

// Guest HTTP on port 80 and HTTPS on port 443 reach this entrypoint; other ports have no route.
// The lane's Git grant arrives as props from its own Durable Object, so each sandbox can reach
// only its own fork (read/write) and the canonical repository (read).
export class Outbound extends WorkerEntrypoint<RunnerEnv, { grant?: LaneGrant }> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const decision = decide(url, request.method, this.ctx.props.grant, {
      accountId: this.env.AI_GATEWAY_ACCOUNT_ID,
      gatewayId: this.env.AI_GATEWAY_ID,
      token: this.env.AI_GATEWAY_TOKEN,
      metadata: this.env.AI_GATEWAY_METADATA,
    });
    if (decision.kind === "deny") return new Response(`${decision.reason}\n`, { status: decision.status });
    const headers = new Headers(request.headers);
    for (const name of decision.remove) headers.delete(name);
    for (const [name, value] of Object.entries(decision.set)) headers.set(name, value);
    return fetch(new Request(request, { headers }));
  }
}
