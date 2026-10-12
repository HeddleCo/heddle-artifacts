// SPDX-License-Identifier: Apache-2.0
// Outbound policy for a coding-agent sandbox. Pure so it can be tested without the Workers runtime.
// The sandbox never holds a credential: every token below is attached here, outside the container.

/** One lane's Git access, issued by the control plane at enrollment. */
export interface LaneGrant {
  forkRemote: string;
  forkToken: string;
  upstreamRemote: string;
  upstreamToken: string;
}

export interface GatewayConfig {
  accountId: string;
  gatewayId: string;
  token: string;
  metadata?: string;
}

export type Decision =
  | { kind: "deny"; status: number; reason: string }
  | { kind: "forward"; set: Record<string, string>; remove: string[] };

export const GATEWAY_HOST = "gateway.ai.cloudflare.com";
export const CLOUDFLARE_API_HOST = "api.cloudflare.com";
/** Cloudflare's unified AI API (OpenAI Responses and Chat Completions) for Workers AI models. */
export const workersAiBase = (accountId: string) => `https://${CLOUDFLARE_API_HOST}/client/v4/accounts/${accountId}/ai/v1`;
export const NPM_REGISTRY_HOST = "registry.npmjs.org";

const deny = (reason: string, status = 403): Decision => ({ kind: "deny", status, reason });

/** True when url addresses the repository at remote (the remote itself or a path below it). */
function inRepository(url: URL, remote: string): boolean {
  const base = new URL(remote);
  if (url.origin !== base.origin) return false;
  return url.pathname === base.pathname || url.pathname.startsWith(`${base.pathname}/`);
}

function isPush(url: URL): boolean {
  return url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
}

export function decide(url: URL, method: string, grant: LaneGrant | undefined, gateway: GatewayConfig): Decision {
  // The Worker re-fetches with the guest's scheme, so a credential on plain HTTP would cross the Internet unencrypted.
  if (url.protocol !== "https:") return deny(`${url.hostname} is reachable only over HTTPS`);

  if (url.hostname === GATEWAY_HOST) {
    const prefix = `/v1/${gateway.accountId}/${gateway.gatewayId}`;
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return deny("only this account's gateway is reachable");
    // Agents need a placeholder key to start; drop it so the gateway bills through Unified Billing.
    return {
      kind: "forward",
      set: { "cf-aig-authorization": `Bearer ${gateway.token}`, ...(gateway.metadata ? { "cf-aig-metadata": gateway.metadata } : {}) },
      remove: ["x-api-key", "authorization"],
    };
  }

  if (url.hostname === CLOUDFLARE_API_HOST) {
    // Only this account's Workers AI inference, routed through its gateway; never the wider Cloudflare API.
    const prefix = new URL(workersAiBase(gateway.accountId)).pathname;
    if (!url.pathname.startsWith(`${prefix}/`)) return deny("only this account's Workers AI inference is reachable");
    if (method !== "POST" && method !== "GET") return deny("Workers AI inference accepts GET and POST only");
    return {
      kind: "forward",
      set: { authorization: `Bearer ${gateway.token}`, "cf-aig-authorization": `Bearer ${gateway.token}`, "cf-aig-gateway-id": gateway.gatewayId,
        ...(gateway.metadata ? { "cf-aig-metadata": gateway.metadata } : {}) },
      remove: ["x-api-key"],
    };
  }

  if (grant && inRepository(url, grant.forkRemote)) {
    return { kind: "forward", set: { authorization: `Bearer ${grant.forkToken}` }, remove: [] };
  }
  if (grant && inRepository(url, grant.upstreamRemote)) {
    // The upstream is read-only for agents; refuse pushes before they reach the server.
    if (isPush(url)) return deny("upstream is read-only");
    return { kind: "forward", set: { authorization: `Bearer ${grant.upstreamToken}` }, remove: [] };
  }

  if (url.hostname === NPM_REGISTRY_HOST) {
    if (method !== "GET" && method !== "HEAD") return deny("the npm registry is read-only from this sandbox");
    return { kind: "forward", set: {}, remove: ["authorization"] };
  }

  return deny(`${url.hostname} is not reachable from this sandbox`);
}

/** Validate a grant against the one Artifacts namespace this runner serves. */
export function validGrant(value: unknown, artifactsHost: string, namespace: string): value is LaneGrant {
  if (typeof value !== "object" || value === null) return false;
  const g = value as Record<string, unknown>;
  const remote = (r: unknown) => {
    if (typeof r !== "string") return false;
    try {
      const u = new URL(r);
      return u.protocol === "https:" && u.hostname === artifactsHost && !u.username && !u.password && !u.search && !u.hash &&
        new RegExp(`^/git/${namespace}/[a-z0-9][a-z0-9-]{0,62}\\.git$`).test(u.pathname);
    } catch { return false; }
  };
  const token = (t: unknown) => typeof t === "string" && t.length > 0 && t.length < 4096 && !/[\r\n\s]/.test(t);
  return remote(g.forkRemote) && remote(g.upstreamRemote) && g.forkRemote !== g.upstreamRemote && token(g.forkToken) && token(g.upstreamToken);
}

/** Where a finished lane posts its agent's message: exactly one task's turns endpoint on the control plane. */
export interface DiscussionTarget { url: string; token: string }
export function validDiscussion(value: unknown, controlPlaneHost: string): value is DiscussionTarget {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  if (typeof d.token !== "string" || !d.token || d.token.length > 4096 || /[\r\n\s]/.test(d.token) || typeof d.url !== "string") return false;
  try {
    const u = new URL(d.url);
    return u.protocol === "https:" && u.hostname === controlPlaneHost && !u.username && !u.password && !u.search && !u.hash &&
      /^\/api\/projects\/[a-z0-9][a-z0-9-]{0,62}\/tasks\/[a-z0-9][a-z0-9-]{0,62}\/turns$/.test(u.pathname);
  } catch { return false; }
}
