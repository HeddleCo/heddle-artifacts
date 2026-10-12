// SPDX-License-Identifier: Apache-2.0
import { LIMITS } from './smoke-safety.mjs';
import { validateBridgeOperation } from './smoke-bridge.mjs';
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const assertId = id => { if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('invalid_resource_id'); return id; };
export function createControlPlane({ plan, ledger, fetchImpl = fetch, apiToken, bridge, authMode = 'api-token', now = Date.now, monotonic = () => performance.now() }) {
  if (!['api-token', 'wrangler-oauth'].includes(authMode)) throw new Error('invalid_auth_mode');
  if (authMode === 'wrangler-oauth' && typeof bridge !== 'function') throw new Error('oauth_bridge_required');
  const base = `/artifacts/namespaces/${plan.target.namespace}`;
  let deadline = Math.min(now() + LIMITS.runSeconds * 1000, Date.parse(plan.expiresAt)), cleanup = false, requests = 0;
  const request = async (path, method = 'GET', body, allow404 = false) => {
    if (now() >= deadline) throw new Error('run_deadline');
    if (++requests > (cleanup ? LIMITS.maxCleanupRequests : LIMITS.maxApiRequests)) throw new Error('api_request_limit');
    const artifacts = path === base || path.startsWith(`${base}/`);
    if ((!artifacts && !/^\/(queues(?:\/|$)|event_subscriptions\/subscriptions(?:\/|$))/.test(path))
      || path.includes('..') || path.includes('%') || path.includes('\\')) throw new Error('unapproved_control_path');
    const accountPath = `/accounts/${plan.target.accountId}${path}`, phase = cleanup ? 'cleanup' : 'normal';
    // The bridge receives no headers, credential, URL, environment, or provider diagnostics.
    if (!artifacts && bridge) validateBridgeOperation({ method, path: accountPath, body: body ?? null, phase }, { plan, ledger });
    // One observation per actual API attempt, without response bodies or secrets.
    // Bridge elapsed time includes connector dispatch; it is not provider latency.
    const started = monotonic(), metric = { method, phase, transport: !artifacts && bridge ? 'connector-bridge' : 'direct-rest',
      operation: artifacts ? path.includes('/tokens') ? 'tokens' : path.includes('/repos') ? 'repositories' : 'namespace'
        : path.includes('event_subscriptions') ? 'event-subscription' : path.includes('/messages/') ? 'queue-messages' : path.includes('/consumers') ? 'queue-consumer' : 'queue',
      status: null, outcome: 'failed', elapsedMs: 0, contentLengthBytes: null };
    try {
      const response = !artifacts && bridge
        ? await bridge({ method, path: accountPath, ...(body === undefined ? {} : { body }), phase, deadline: Math.min(deadline, now() + LIMITS.apiSeconds * 1000) })
        : await fetchImpl(`https://api.cloudflare.com/client/v4${accountPath}`, {
        method, redirect: 'error', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.min(LIMITS.apiSeconds * 1000, deadline - now()))) });
      metric.status = response.status;
      const length = response.headers?.get?.('content-length');
      if (typeof length === 'string' && /^\d{1,12}$/.test(length)) metric.contentLengthBytes = Number(length);
      if (allow404 && response.status === 404) { metric.outcome = 'allowed-absent'; return null; }
      if (cleanup && !artifacts && method === 'DELETE' && response.status === 202) throw new Error('cleanup_unconfirmed');
      const value = await response.json();
      if (!response.ok || value.success !== true) throw new Error(`control_plane_${response.status}`);
      metric.outcome = 'success'; return value;
    } finally {
      metric.elapsedMs = Math.max(0, Number((monotonic() - started).toFixed(3)));
      // Existing state transitions/finalization persist this bounded array. Do
      // not introduce a fallible telemetry write after a provider mutation.
      (ledger.state.apiTimings ||= []).push(metric);
    }
  };
  const api = async (...args) => (await request(...args))?.result ?? null;
  const repoRecord = name => {
    const resource = ledger.state.resources.find(r => r.kind === 'repo' && r.name === name);
    if (!resource || resource.status === 'deleted') throw new Error('unowned_resource');
    return resource;
  };
  const assertOwnedRepo = async name => {
    const resource = repoRecord(name), current = await api(`${base}/repos/${name}`, 'GET', undefined, true);
    if (!current || current.id !== resource.id || current.name !== resource.name) throw new Error('resource_identity_changed');
    return resource;
  };
  const preflight = async () => {
    const ns = await api(base);
    if (!ns || (ns.namespace ?? ns.name) !== plan.target.namespace || (ns.jurisdiction ?? 'unrestricted') !== plan.target.jurisdiction) throw new Error('namespace_mismatch');
    for (const name of plan.resources.repositories) if (await api(`${base}/repos/${name}`, 'GET', undefined, true)) throw new Error('preexisting_resource');
    const queues = await request('/queues');
    if (!Array.isArray(queues.result) || !Number.isInteger(queues.result_info?.total_pages) || queues.result_info.total_pages > 1
      || queues.result_info.total_count !== queues.result.length) throw new Error('preflight_inventory_incomplete');
    if (queues.result.some(q => q.queue_name === plan.resources.queue)) throw new Error('preexisting_resource');
  };
  const create = async (kind, name, path, body, { parentId } = {}) => {
    const expected = kind === 'repo' ? plan.resources.repositories.includes(name)
      : kind === 'queue' ? name === plan.resources.queue
      : kind === 'subscription' ? name === plan.resources.eventSubscription
      : kind === 'consumer' && name === 'http_pull';
    if (!expected || ledger.state.resources.some(r => r.kind === kind && r.name === name)) throw new Error('unplanned_resource');
    const pending = { kind, name, ...(parentId ? { parentId } : {}), state: 'create_outcome_unknown' };
    ledger.state.pending.push(pending); await ledger.save();
    // A failed or interrupted POST is never retried or adopted by name.
    const value = await api(path, 'POST', body);
    const id = assertId(kind === 'queue' ? value?.queue_id : kind === 'consumer' ? value?.consumer_id : value?.id);
    if (kind === 'repo' && value.name !== name || kind === 'queue' && value.queue_name !== name) throw new Error('created_name_mismatch');
    const resource = { kind, name, id, ...(parentId ? { parentId } : {}), status: 'created', ...(kind === 'repo' ? { tokens: [], bootstrapDiscovered: false } : {}) };
    ledger.state.resources.push(resource); ledger.state.pending.splice(ledger.state.pending.indexOf(pending), 1); await ledger.save();
    return value;
  };
  const discoverTokens = async name => {
    const resource = await assertOwnedRepo(name);
    const response = await request(`${base}/repos/${name}/tokens?state=active&per_page=100&page=1`);
    if (!Array.isArray(response.result) || !Number.isInteger(response.result_info?.total_pages) || response.result_info.total_pages > 1
      || response.result_info.total_count !== response.result.length || response.result.length > 3
      || (!resource.bootstrapDiscovered && response.result.length !== 1)) throw new Error('unexpected_token_inventory');
    for (const token of response.result) {
      assertId(token.id);
      if (!resource.tokens.some(t => t.id === token.id)) resource.tokens.push({ id: token.id, scope: token.scope, expiresAt: token.expires_at, status: 'active', source: resource.bootstrapDiscovered ? 'discovered_on_new_repo' : 'bootstrap' });
    }
    resource.bootstrapDiscovered = true; await ledger.save(); return resource;
  };
  const revokeTokens = async name => {
    const resource = await discoverTokens(name);
    for (const token of resource.tokens.filter(t => t.status !== 'revoked')) {
      await api(`${base}/tokens/${assertId(token.id)}`, 'DELETE', undefined, true);
      token.status = 'revoked'; await ledger.save();
    }
  };
  const mint = async (name, scope) => {
    const resource = await assertOwnedRepo(name);
    const approved = plan.resources.explicitTokens.find(t => t.repo === name && t.scope === scope);
    if (!approved || !resource.bootstrapDiscovered || !resource.tokens.some(t => t.source === 'bootstrap' && t.status === 'revoked')
      || resource.tokens.some(t => t.source === 'explicit' && t.scope === scope)) throw new Error('unplanned_token');
    const pending = { kind: 'token', name, scope, state: 'create_outcome_unknown' };
    ledger.state.pending.push(pending); await ledger.save();
    const value = await api(`${base}/tokens`, 'POST', { repo: name, scope, ttl: approved.ttl });
    const id = assertId(value?.id);
    resource.tokens.push({ id, scope, expiresAt: value.expires_at, source: 'explicit', status: 'active' });
    ledger.state.pending.splice(ledger.state.pending.indexOf(pending), 1); await ledger.save();
    if (typeof value.plaintext !== 'string' || !value.plaintext || Date.parse(value.expires_at) > now() + 601000 || !(Date.parse(value.expires_at) > now())) throw new Error('token_expiry_mismatch');
    return value.plaintext;
  };
  const beginCleanup = () => { cleanup = true; requests = 0; deadline = now() + LIMITS.cleanupSeconds * 1000; };
  const cleanupResources = async record => {
    beginCleanup();
    const fail = async (resource, error) => {
      const failure = { kind: resource.kind, name: resource.name, id: resource.id, reason: error?.message === 'resource_identity_changed' ? 'resource_identity_changed' : 'cleanup_unconfirmed' };
      ledger.state.cleanupFailures.push(failure); record(`CLEANUP FAIL ${resource.kind} ${resource.name}: ${failure.reason}`); await ledger.save();
    };
    const resources = ledger.state.resources;
    for (const resource of [...resources.filter(r => r.kind === 'subscription'), ...resources.filter(r => r.kind === 'repo').reverse(), ...resources.filter(r => r.kind === 'consumer'), ...resources.filter(r => r.kind === 'queue')]) {
      try {
        if (resource.kind === 'repo') {
          const current = await api(`${base}/repos/${resource.name}`, 'GET', undefined, true);
          if (current) {
            if (current.id !== resource.id || current.name !== resource.name) throw new Error('resource_identity_changed');
            // Revoke bootstrap and explicit tokens before deletion; failed revocation is not concealed by deletion.
            await revokeTokens(resource.name);
            await assertOwnedRepo(resource.name);
            await api(`${base}/repos/${resource.name}`, 'DELETE');
            resource.status = 'delete_requested'; await ledger.save();
            let remaining = await api(`${base}/repos/${resource.name}`, 'GET', undefined, true);
            for (let attempt = 0; remaining && attempt < 4; attempt++) {
              if (remaining.id !== resource.id) throw new Error('resource_identity_changed');
              await new Promise(r => setTimeout(r, 1000)); remaining = await api(`${base}/repos/${resource.name}`, 'GET', undefined, true);
            }
            if (remaining) throw new Error('cleanup_unconfirmed');
          }
        } else {
          const path = resource.kind === 'subscription' ? `/event_subscriptions/subscriptions/${assertId(resource.id)}`
            : resource.kind === 'consumer' ? `/queues/${assertId(resource.parentId)}/consumers/${assertId(resource.id)}` : `/queues/${assertId(resource.id)}`;
          await api(path, 'DELETE', undefined, true);
        }
        resource.status = 'deleted'; await ledger.save(); record(`CLEANUP PASS ${resource.kind} ${resource.name}`);
      } catch (error) { await fail(resource, error); }
    }
    for (const pending of ledger.state.pending) record(`CLEANUP UNKNOWN ${pending.kind} ${pending.name}: manual reconciliation required; never adopted or deleted by name`);
    return ledger.state.cleanupFailures.length === 0 && ledger.state.pending.length === 0;
  };
  return { base, api, preflight, create, assertOwnedRepo, revokeTokens, mint, cleanupResources, remainingMs: () => Math.max(0, deadline - now()) };
}
