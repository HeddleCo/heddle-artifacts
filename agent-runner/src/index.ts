// SPDX-License-Identifier: Apache-2.0
// Heddle agent runner: runs a coding agent per lane in a Cloudflare Sandbox.
//   POST   /lanes/:agent/:name       { grant, prompt, author, model? }  start the lane (operator only)
//   GET    /lanes/:agent/:name       outcome: none | running | succeeded | failed | lost
//   GET    /lanes/:agent/:name/log   last bytes of the agent's JSON event stream
//   DELETE /lanes/:agent/:name       destroy the sandbox
import { validGrant } from "./policy";
import type { LaneSandbox, RunnerEnv } from "./lane";

export { CodexLane, ClaudeLane, OpencodeLane } from "./agents";
export { Outbound } from "./outbound";

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// The prompt is one argv entry; Linux rejects an argument of 128 KiB or more.
const MAX_PROMPT_BYTES = 64 * 1024;

async function authorized(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  if (!token || !header.startsWith("Bearer ")) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(header.slice(7)), digest(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function author(value: unknown): value is { name: string; email: string } {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return typeof a.name === "string" && /^[\w .-]{1,64}$/.test(a.name) && typeof a.email === "string" && /^[\w.+-]{1,64}@[\w.-]{1,128}$/.test(a.email);
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!(await authorized(request, env.RUNNER_TOKEN))) return new Response("Forbidden\n", { status: 403 });
    const match = /^\/lanes\/(codex|claude|opencode)\/([^/]+)(\/log)?$/.exec(new URL(request.url).pathname);
    if (!match || !NAME.test(match[2])) return new Response("Not found\n", { status: 404 });
    const [, agent, name, log] = match;
    const lane = (agent === "codex" ? env.CODEX : agent === "claude" ? env.CLAUDE : env.OPENCODE).getByName(name) as unknown as DurableObjectStub<LaneSandbox>;
    try {
      if (log) return request.method === "GET" ? new Response(await lane.tail(16 * 1024), { headers: { "content-type": "application/x-ndjson" } }) : new Response(null, { status: 405 });
      if (request.method === "GET") return Response.json(await lane.status());
      if (request.method === "DELETE") { await lane.reset(); return new Response(null, { status: 204 }); }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
      if (!body || !validGrant(body.grant, env.ARTIFACTS_HOST, env.ARTIFACTS_NAMESPACE) || !author(body.author) ||
          typeof body.prompt !== "string" || !body.prompt.trim() || new TextEncoder().encode(body.prompt).byteLength > MAX_PROMPT_BYTES) {
        return new Response("Body must be { grant, prompt, author } for this Artifacts namespace\n", { status: 400 });
      }
      // A per-lane model is limited to Workers AI models, which the outbound policy can reach.
      if (body.model !== undefined && (agent !== "opencode" || typeof body.model !== "string" || !/^cloudflare-workers-ai\/@cf\/[\w.-]+\/[\w.-]+$/.test(body.model))) {
        return new Response("model must be a cloudflare-workers-ai/@cf/... id on an opencode lane\n", { status: 400 });
      }
      const started = await lane.start(name, { grant: body.grant, prompt: body.prompt, author: body.author, ...(body.model ? { model: body.model as string } : {}) });
      if (started === "busy") return new Response("Lane already ran\n", { status: 409 });
      if (started !== "started") return Response.json(started, { status: 502 });
      return Response.json({ state: "running" }, { status: 202 });
    } catch (cause) {
      // Never echo internals: stacks can carry request material.
      console.error({ event: "lane.request.failed", agent, name, error: cause instanceof Error ? cause.name : "unknown" });
      return new Response("Lane request failed\n", { status: 500 });
    }
  },
} satisfies ExportedHandler<RunnerEnv>;
