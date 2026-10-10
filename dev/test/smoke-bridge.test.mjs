// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { makePlan, createLedger } from '../smoke-safety.mjs';
import { createControlPlane } from '../smoke-control.mjs';
import { smoke } from '../smoke-artifacts.mjs';
import { BRIDGE_LIMITS, createFileControlBridge, listBridgeRequests, claimBridgeRequests, writeBridgeResponse, validateBridgeOperation,
  validateBridgeRequest, makeBridgeResponse, validateBridgeResponse, sanitizeBridgeValue, bridgeMain } from '../smoke-bridge.mjs';
const accountId = 'a'.repeat(32), rootPath = `/accounts/${accountId}`, queueId = 'owned-queue';
async function fixture(t) {
  const root = await mkdtemp('/tmp/smoke-bridge-fixture-'); t.after(() => rm(root, { recursive: true, force: true }));
  const plan = makePlan({ runId: 'bridge-test', accountId, accountName: 'Synthetic', accountPlan: 'Workers Paid', namespace: 'heddle-demo', jurisdiction: 'unrestricted' });
  const ledger = await createLedger(join(root, 'ledger'), plan), bridge = await createFileControlBridge({ root, plan, ledger });
  const context = { plan, ledger }, now = Date.now();
  const request = { version: 1, requestId: randomUUID(), runId: plan.runId, planDigest: plan.digest,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 9000).toISOString(), phase: 'normal', method: 'GET', path: `${rootPath}/queues`, body: null };
  const provider = { status: 200, value: { success: true, result: [], result_info: { total_pages: 1, total_count: 0 } } };
  return { root, plan, ledger, bridge, context, request, provider };
}
const addQueue = ledger => ledger.state.resources.push({ kind: 'queue', name: ledger.state.plan.resources.queue, id: queueId, status: 'created' });
const operation = (path, method = 'GET', body = null, phase = 'normal') => ({ path: `${rootPath}${path}`, method, body, phase });
async function waitPending(f) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) { const requests = await listBridgeRequests({ directory: f.bridge.directory, ...f.context }); if (requests.length) return requests[0]; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('fixture pending deadline');
}
test('bridge accepts only exact planned operations and ledger-owned targets without credential fields', async t => {
  const f = await fixture(t), validate = value => validateBridgeOperation(value, f.context);
  assert.equal(validate(operation('/queues')), 'queue-list');
  f.ledger.state.pending.push({ kind: 'queue', name: f.plan.resources.queue, state: 'create_outcome_unknown' });
  assert.equal(validate(operation('/queues', 'POST', { queue_name: f.plan.resources.queue })), 'queue-create');
  for (const value of [operation('/queues?per_page=100'), operation('/queues', 'POST', { queue_name: 'foreign' }),
    operation('/queues', 'POST', { queue_name: f.plan.resources.queue, Authorization: 'SECRET' }),
    operation('/queues/foreign', 'DELETE'), operation('/queues/../tokens'), operation('/artifacts/namespaces/heddle-demo'),
    operation('/queues', 'PATCH'), { ...operation('/queues'), path: '/accounts/' + 'b'.repeat(32) + '/queues' },
    operation('/queues', 'GET', null, 'cleanup')]) assert.throws(() => validate(value), /bridge_invalid/);
  addQueue(f.ledger); f.ledger.state.pending = [{ kind: 'consumer', name: 'http_pull', parentId: queueId, state: 'create_outcome_unknown' }];
  assert.equal(validate(operation(`/queues/${queueId}/consumers`, 'POST', { type: 'http_pull', settings: { visibility_timeout_ms: 10000 } })), 'consumer-create');
  assert.equal(validate(operation(`/queues/${queueId}/messages/pull`, 'POST', { batch_size: 20, visibility_timeout_ms: 10000 })), 'pull');
  assert.equal(validate(operation(`/queues/${queueId}/messages/ack`, 'POST', { acks: [{ lease_id: 'synthetic-lease' }], retries: [] })), 'ack');
  assert.throws(() => validate(operation(`/queues/${queueId}/messages/ack`, 'POST', { acks: [{ lease_id: 'synthetic', authorization: 'SECRET' }], retries: [] })), /bridge_invalid/);
  assert.throws(() => validate(operation(`/queues/${queueId}/messages/pull`, 'POST', { batch_size: 21, visibility_timeout_ms: 10000 })), /bridge_invalid/);
  assert.equal(validate(operation(`/queues/${queueId}`, 'DELETE', null, 'cleanup')), 'delete');
  f.ledger.state.resources[0].status = 'deleted'; assert.throws(() => validate(operation(`/queues/${queueId}`, 'DELETE')), /bridge_invalid/);
});
test('request and response are bound to plan, account, exact method/path, unique ID and deadline', async t => {
  const f = await fixture(t), response = makeBridgeResponse(f.request, f.provider, f.context);
  assert.equal(validateBridgeResponse(response, f.request, f.context).status, 200);
  for (const changes of [{ requestId: randomUUID() }, { requestDigest: 'f'.repeat(64) }, { runId: 'another' }, { planDigest: 'f'.repeat(64) },
    { method: 'DELETE' }, { path: `${rootPath}/queues/foreign` }, { completedAt: 'invalid' },
    { completedAt: new Date(Date.parse(f.request.createdAt) - 1).toISOString() }, { authorization: 'SECRET' }]) {
    assert.throws(() => validateBridgeResponse({ ...response, ...changes }, f.request, f.context), /bridge_invalid/);
  }
  assert.throws(() => validateBridgeResponse(response, f.request, { ...f.context, now: Date.parse(f.request.expiresAt) }), /bridge_expired/);
  for (const changes of [{ expiresAt: new Date(Date.parse(f.request.createdAt) + 10001).toISOString() },
    { createdAt: new Date(Date.now() + 10000).toISOString() }, { runId: 'foreign' }, { headers: { Authorization: 'SECRET' } }]) {
    assert.throws(() => validateBridgeRequest({ ...f.request, ...changes }, f.context), /bridge_invalid|bridge_expired/);
  }
});
test('provider normalization strips headers, token fields, diagnostics and unneeded event content', async t => {
  const f = await fixture(t);
  const response = makeBridgeResponse(f.request, { status: 200, value: { ...f.provider.value, headers: { authorization: 'SECRET' }, token: 'SECRET', errors: ['SECRET'] } }, f.context);
  assert(!JSON.stringify(response).includes('SECRET'));
  const error = makeBridgeResponse(f.request, { status: 403, value: { success: false, errors: [{ message: 'SECRET' }] } }, f.context);
  assert.deepEqual(error.value, { success: false, result: null });
  const event = { type: 'cf.artifacts.repo.pushed', source: { namespace: f.plan.target.namespace, repoName: f.plan.resources.repositories[0] }, payload: { ref: 'refs/heads/main', extra: 'SECRET' } };
  const pull = sanitizeBridgeValue('pull', 200, { success: true, result: { messages: [{ lease_id: 'synthetic-lease', body: Buffer.from(JSON.stringify(event)).toString('base64'), private: 'SECRET' }] } }, f.plan);
  assert(!JSON.stringify(pull).includes('SECRET')); assert.equal(pull.result.messages[0].body.payload.ref, 'refs/heads/main');
  assert.throws(() => sanitizeBridgeValue('pull', 200, { success: true, result: { messages: [{ lease_id: 'x', body: { ...event, source: { ...event.source, repoName: 'foreign' } } }] } }, f.plan), /bridge_invalid/);
  assert.throws(() => sanitizeBridgeValue('delete', 202, { success: true, result: {} }, f.plan), /bridge_cleanup_unconfirmed/);
});
test('private file bridge completes request/response end to end and refuses replay or reuse', async t => {
  const f = await fixture(t), started = Date.now();
  const waiting = f.bridge.request({ method: 'GET', path: `${rootPath}/queues`, phase: 'normal', deadline: Date.now() + 9000 });
  const request = await waitPending(f);
  assert.equal((await claimBridgeRequests({ directory: f.bridge.directory, ...f.context })).length, 1);
  await writeBridgeResponse({ directory: f.bridge.directory, requestId: request.requestId, providerResponse: f.provider, ...f.context });
  const response = await waiting; assert.equal(response.status, 200); assert.deepEqual(await response.json(), f.provider.value);
  assert(Date.now() - started < 10000); assert.deepEqual(await listBridgeRequests({ directory: f.bridge.directory, ...f.context }), []);
  await assert.rejects(writeBridgeResponse({ directory: f.bridge.directory, requestId: request.requestId, providerResponse: f.provider, ...f.context }), { code: 'EEXIST' });
  await assert.rejects(createFileControlBridge({ root: f.root, ...f.context }), { code: 'EEXIST' });
  for (const file of await readdir(f.bridge.directory)) {
    assert.equal((await stat(join(f.bridge.directory, file))).mode & 0o777, 0o600);
    assert(!/authorization|Bearer|SECRET/.test(await readFile(join(f.bridge.directory, file), 'utf8')));
  }
});
test('file bridge rejects symlink responses, output overflow and unavailable timely responses', async t => {
  for (const mode of ['symlink', 'oversize', 'timeout']) {
    const f = await fixture(t);
    const waiting = f.bridge.request({ method: 'GET', path: `${rootPath}/queues`, phase: 'normal', deadline: Date.now() + 100 });
    const rejection = assert.rejects(waiting, /bridge_invalid|bridge_timeout/); const request = await waitPending(f);
    const path = join(f.bridge.directory, `${request.requestId}.response.json`);
    if (mode === 'symlink') { const target = join(f.root, 'fixture'); await writeFile(target, '{}', { mode: 0o600 }); await symlink(target, path); }
    if (mode === 'oversize') await writeFile(path, 'x'.repeat(BRIDGE_LIMITS.maxResponseBytes + 1), { mode: 0o600 });
    await rejection;
  }
});
test('bridge CLI uses non-secret explicit files and stdin, with no response overwrite', async t => {
  const f = await fixture(t), planPath = join(f.root, 'plan.json'); await writeFile(planPath, JSON.stringify(f.plan), { mode: 0o600 });
  const args = ['--bridge-dir', f.bridge.directory, '--plan-file', planPath, '--ledger-file', f.ledger.path], out = [];
  const waiting = f.bridge.request({ method: 'GET', path: `${rootPath}/queues`, phase: 'normal', deadline: Date.now() + 9000 });
  const request = await waitPending(f);
  assert.equal(await bridgeMain(['--pending', ...args], { log: s => out.push(s) }), 0); assert.equal(JSON.parse(out[0])[0].requestId, request.requestId);
  assert.equal(await bridgeMain(['--claim', ...args], { log: s => out.push(s) }), 0);
  assert.equal(await bridgeMain(['--respond', ...args, '--request-id', request.requestId], { stdin: Readable.from([JSON.stringify(f.provider)]), log: s => out.push(s) }), 0);
  assert.equal((await waiting).status, 200);
  assert.equal(await bridgeMain(['--respond', ...args, '--request-id', request.requestId], { stdin: Readable.from([JSON.stringify(f.provider)]), log: s => out.push(s) }), 2);
});
test('split control keeps OAuth exclusively on Artifacts REST and cleans only new bridge resources', async t => {
  const f = await fixture(t), direct = [], bridged = [], secret = 'SYNTHETIC-OAUTH-NEVER-BRIDGE';
  const fetchImpl = async (url, opts) => {
    direct.push(url); assert(url.includes('/artifacts/namespaces/')); assert.equal(opts.headers.authorization, `Bearer ${secret}`);
    return { status: 200, ok: true, json: async () => ({ success: true, result: { namespace: f.plan.target.namespace, jurisdiction: null } }) };
  };
  const bridge = async request => {
    bridged.push(request); assert(!JSON.stringify(request).includes(secret)); assert(!Object.hasOwn(request, 'headers'));
    let result;
    if (request.method === 'POST' && request.path.endsWith('/queues')) result = { queue_id: queueId, queue_name: f.plan.resources.queue };
    else if (request.method === 'POST' && request.path.endsWith('/consumers')) result = { consumer_id: 'owned-consumer' };
    else if (request.method === 'POST' && request.path.endsWith('/subscriptions')) result = { id: 'owned-subscription' };
    else if (request.method === 'DELETE') result = null;
    else throw new Error('unexpected request');
    return { status: 200, ok: true, json: async () => ({ success: true, result }) };
  };
  const control = createControlPlane({ ...f.context, fetchImpl, apiToken: secret, authMode: 'wrangler-oauth', bridge });
  await control.api(control.base);
  await control.create('queue', f.plan.resources.queue, '/queues', { queue_name: f.plan.resources.queue });
  await control.create('consumer', 'http_pull', `/queues/${queueId}/consumers`, { type: 'http_pull', settings: { visibility_timeout_ms: 10000 } }, { parentId: queueId });
  await control.create('subscription', f.plan.resources.eventSubscription, '/event_subscriptions/subscriptions', { name: f.plan.resources.eventSubscription, enabled: true, source: { type: 'artifacts.repo', namespace: f.plan.target.namespace, repo_name: f.plan.resources.repositories[0] }, events: ['pushed'], destination: { type: 'queues.queue', queue_id: queueId } });
  assert.equal(await control.cleanupResources(() => {}), true); assert.equal(direct.length, 1); assert.equal(bridged.length, 6);
  assert(bridged.slice(-3).every(request => request.phase === 'cleanup')); assert(f.ledger.state.resources.every(r => r.status === 'deleted'));
  assert.throws(() => createControlPlane({ ...f.context, apiToken: secret, authMode: 'wrangler-oauth' }), /oauth_bridge_required/);
  await assert.rejects(control.api('/user/tokens'), /unapproved_control_path/);
});
test('bridge lost create response stays unknown, and asynchronous queue deletion is never success', async t => {
  for (const scenario of ['lost-create', 'pending-delete']) {
    const f = await fixture(t);
    const control = createControlPlane({ ...f.context, authMode: 'wrangler-oauth', apiToken: 'synthetic', bridge: async () => {
      if (scenario === 'lost-create') throw new Error('bridge_timeout');
      return { ok: true, status: 202, json: async () => ({ success: true, result: {} }) };
    } });
    if (scenario === 'lost-create') await assert.rejects(control.create('queue', f.plan.resources.queue, '/queues', { queue_name: f.plan.resources.queue }), /bridge_timeout/);
    else addQueue(f.ledger);
    assert.equal(await control.cleanupResources(() => {}), false);
    if (scenario === 'lost-create') assert.equal(f.ledger.state.pending.length, 1);
    else { assert.equal(f.ledger.state.cleanupFailures.length, 1); assert.equal(f.ledger.state.resources[0].status, 'created'); }
  }
});
test('live OAuth injection cannot access ambient token and fails before resources when mocked preflight fails', async t => {
  const f = await fixture(t), root = join(f.root, 'injected-ledger'), logs = []; let authCalls = 0, bridgeCalls = 0;
  const env = { CF_ACCOUNT_ID: accountId, get CLOUDFLARE_API_TOKEN() { throw new Error('ambient API token was accessed'); } };
  const status = await smoke({ plan: f.plan, runId: f.plan.runId, ledgerDir: root, env, authMode: 'wrangler-oauth', oauthHome: '/tmp/explicit-synthetic', bridgeDir: '/tmp/explicit-synthetic-bridge',
    oauthTokenProvider: async options => { authCalls++; assert.equal(options.home, '/tmp/explicit-synthetic'); return 'SYNTHETIC-ONLY'; },
    bridgeFactory: async () => ({ directory: '/tmp/explicit-synthetic-bridge', request: async () => { bridgeCalls++; throw new Error('should not reach bridge'); } }),
    fetchImpl: async (url, options) => { assert(url.includes('/artifacts/')); assert.equal(options.headers.authorization, 'Bearer SYNTHETIC-ONLY'); return { ok: false, status: 403, json: async () => ({ success: false, errors: ['SECRET'] }) }; },
    log: message => logs.push(message) });
  assert.equal(status, 1); assert.equal(authCalls, 1); assert.equal(bridgeCalls, 0); assert(!logs.join('\n').includes('SECRET')); assert(!logs.some(s => s.startsWith('A-S1 PASS')));
});

test('plan contents are verified against a recomputed digest and the complete ledger plan', async t => {
  const f = await fixture(t);
  for (const altered of [{ ...f.plan, target: { ...f.plan.target, accountId: 'b'.repeat(32) } },
    { ...f.plan, resources: { ...f.plan.resources, queue: 'foreign' } }, { ...f.plan, limits: { ...f.plan.limits, apiSeconds: 1000 } }]) {
    assert.throws(() => validateBridgeRequest(f.request, { plan: altered, ledger: { state: { ...f.ledger.state, plan: altered } } }), /bridge_invalid/);
  }
  assert.throws(() => validateBridgeRequest(f.request, { plan: f.plan, ledger: { state: { ...f.ledger.state, plan: { ...f.plan, authorization: 'changed' } } } }), /bridge_invalid/);
});
test('exclusive claims prevent redispatch after races or lost responses and cannot be skipped', async t => {
  const f = await fixture(t);
  const waiting = f.bridge.request({ method: 'GET', path: `${rootPath}/queues`, phase: 'normal', deadline: Date.now() + 9000 });
  const request = await waitPending(f);
  await assert.rejects(writeBridgeResponse({ directory: f.bridge.directory, requestId: request.requestId, providerResponse: f.provider, ...f.context }), { code: 'ENOENT' });
  const claimed = await Promise.all([claimBridgeRequests({ directory: f.bridge.directory, ...f.context }), claimBridgeRequests({ directory: f.bridge.directory, ...f.context })]);
  assert.equal(claimed.flat().length, 1);
  assert.deepEqual(await claimBridgeRequests({ directory: f.bridge.directory, ...f.context }), []);
  assert.deepEqual(await listBridgeRequests({ directory: f.bridge.directory, ...f.context }), []);
  await writeBridgeResponse({ directory: f.bridge.directory, requestId: request.requestId, providerResponse: f.provider, ...f.context });
  assert.equal((await waiting).status, 200);
});

test('ledger rejects shared/symlink directories and never follows predictable staging links', async t => {
  const f = await fixture(t), shared = join(f.root, 'shared'); await mkdir(shared, { mode: 0o700 }); await chmod(shared, 0o777);
  await assert.rejects(createLedger(shared, f.plan), /private_directory_required/);
  const alias = join(f.root, 'alias'); await symlink(join(f.root, 'ledger'), alias);
  await assert.rejects(createLedger(alias, f.plan), /private_directory_required/);
  const victim = join(f.root, 'synthetic-victim'); await writeFile(victim, 'unchanged', { mode: 0o600 });
  await symlink(victim, `${f.ledger.path}.next`); f.ledger.state.status = 'synthetic-updated'; await f.ledger.save();
  assert.equal(await readFile(victim, 'utf8'), 'unchanged');
  assert.equal(JSON.parse(await readFile(f.ledger.path, 'utf8')).status, 'synthetic-updated');
});
test('invalid ledger start times and finished ledgers cannot disable request expiry', async t => {
  const f = await fixture(t);
  for (const startedAt of [undefined, 'invalid', new Date(Date.parse(f.plan.createdAt) - 1).toISOString(), f.plan.expiresAt]) {
    assert.throws(() => validateBridgeRequest(f.request, { ...f.context, ledger: { state: { ...f.ledger.state, startedAt } } }), /bridge_expired/);
  }
  assert.throws(() => validateBridgeRequest(f.request, { ...f.context, now: NaN }), /bridge_expired/);
  assert.throws(() => validateBridgeRequest(f.request, { ...f.context, ledger: { state: { ...f.ledger.state, status: 'failed_or_cleanup_incomplete' } } }), /bridge_expired/);
});
