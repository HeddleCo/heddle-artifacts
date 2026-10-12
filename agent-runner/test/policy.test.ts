// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, validGrant, type LaneGrant } from "../src/policy.ts";

const host = "acct.artifacts.cloudflare.net";
const grant: LaneGrant = {
  forkRemote: `https://${host}/git/heddle-demo/demo--parser-escapes--alice.git`, forkToken: "fork-write",
  upstreamRemote: `https://${host}/git/heddle-demo/demo.git`, upstreamToken: "canonical-read",
};
const gateway = { accountId: "acct", gatewayId: "heddle-artifacts", token: "gw-token" };
const at = (u: string, method = "GET") => decide(new URL(u), method, grant, gateway);

test("gateway requests get the gateway token and lose any placeholder provider key", () => {
  const d = at("https://gateway.ai.cloudflare.com/v1/acct/heddle-artifacts/anthropic/v1/messages", "POST");
  assert.equal(d.kind, "forward");
  assert.equal(d.kind === "forward" && d.set["cf-aig-authorization"], "Bearer gw-token");
  assert.deepEqual(d.kind === "forward" && d.remove, ["x-api-key", "authorization"]);
  assert.equal(at("https://gateway.ai.cloudflare.com/v1/other/heddle-artifacts/openai").kind, "deny");
  assert.equal(at("https://gateway.ai.cloudflare.com/v1/acct/heddle-artifacts-evil/openai").kind, "deny");
});

test("the fork gets its write token, the upstream its read token, and upstream pushes are refused", () => {
  const push = at(`${grant.forkRemote}/git-receive-pack`, "POST");
  assert.equal(push.kind === "forward" && push.set.authorization, "Bearer fork-write");
  const fetch = at(`${grant.upstreamRemote}/info/refs?service=git-upload-pack`);
  assert.equal(fetch.kind === "forward" && fetch.set.authorization, "Bearer canonical-read");
  assert.equal(at(`${grant.upstreamRemote}/git-receive-pack`, "POST").kind, "deny");
  assert.equal(at(`${grant.upstreamRemote}/info/refs?service=git-receive-pack`).kind, "deny");
});

test("other repositories, prefix look-alikes, plain HTTP and arbitrary hosts are denied", () => {
  assert.equal(at(`https://${host}/git/heddle-demo/demo--parser-escapes--bob.git/info/refs`).kind, "deny");
  assert.equal(at(`https://${host}/git/heddle-demo/demo.git-evil/info/refs`).kind, "deny");
  assert.equal(at(`http://${host}/git/heddle-demo/demo.git/info/refs`).kind, "deny");
  assert.equal(at("https://example.com/").kind, "deny");
  assert.equal(at("https://github.com/cloudflare/sandbox-sdk").kind, "deny");
  assert.equal(decide(new URL(`${grant.forkRemote}/info/refs`), "GET", undefined, gateway).kind, "deny");
});

test("npm registry is read-only and never receives a credential", () => {
  const d = at("https://registry.npmjs.org/vitest");
  assert.equal(d.kind, "forward");
  assert.deepEqual(d.kind === "forward" && d.set, {});
  assert.ok(d.kind === "forward" && d.remove.includes("authorization"));
  assert.equal(at("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", "POST").kind, "deny");
});

test("grants must name this namespace over HTTPS with clean single-line tokens", () => {
  assert.ok(validGrant(grant, host, "heddle-demo"));
  for (const bad of [
    { ...grant, forkRemote: grant.forkRemote.replace("heddle-demo", "other") },
    { ...grant, forkRemote: grant.forkRemote.replace("https:", "http:") },
    { ...grant, forkRemote: grant.forkRemote.replace("https://", "https://u:p@") },
    { ...grant, forkRemote: `${grant.forkRemote}?x=1` },
    { ...grant, upstreamRemote: grant.forkRemote },
    { ...grant, forkToken: "a\nb" },
    { ...grant, upstreamToken: "" },
  ]) assert.equal(validGrant(bad, host, "heddle-demo"), false, JSON.stringify(bad));
});
