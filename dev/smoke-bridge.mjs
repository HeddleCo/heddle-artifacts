// SPDX-License-Identifier: Apache-2.0
// Credential-free, single-run transport for an already authorized Cloudflare connector.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, link, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isMain } from '../cli/ha.mjs';
import { assertPrivateDirectory } from './smoke-auth.mjs';
import { LIMITS, makePlan } from './smoke-safety.mjs';

export const BRIDGE_LIMITS = Object.freeze({ maxRequestBytes: 16384, maxResponseBytes: 65536, pollMs: 50 });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const lease = value => typeof value === 'string' && /^[A-Za-z0-9._~+/=-]{1,512}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = () => { throw new Error('bridge_invalid'); };
const exactKeys = (object, names) => object && !Array.isArray(object) && typeof object === 'object'
  && Object.keys(object).sort().join(',') === names.slice().sort().join(',');
const owned = (ledger, kind, resourceId) => ledger.state.resources.find(r => r.kind === kind && r.id === resourceId && r.status === 'created');
const pending = (ledger, kind, name) => ledger.state.pending.some(r => r.kind === kind && r.name === name && r.state === 'create_outcome_unknown')
  && !ledger.state.resources.some(r => r.kind === kind && r.name === name);

export function validateBridgeOperation({ method, path, body = null, phase }, { plan, ledger }) {
  if (!['normal', 'cleanup'].includes(phase) || !['GET', 'POST', 'DELETE'].includes(method)
    || typeof path !== 'string' || !path.startsWith(`/accounts/${plan.target.accountId}/`)) fail();
  const suffix = path.slice(`/accounts/${plan.target.accountId}`.length);
  if (phase === 'cleanup' && method !== 'DELETE') fail();
  if (suffix === '/queues' && method === 'GET' && body === null) return 'queue-list';
  if (suffix === '/queues' && method === 'POST' && pending(ledger, 'queue', plan.resources.queue)
    && equal(body, { queue_name: plan.resources.queue })) return 'queue-create';
  const queue = suffix.match(/^\/queues\/([A-Za-z0-9_-]{1,128})(?:\/(consumers|messages\/pull|messages\/ack)(?:\/([A-Za-z0-9_-]{1,128}))?)?$/);
  if (queue && owned(ledger, 'queue', queue[1])) {
    if (!queue[2] && method === 'DELETE' && body === null) return 'delete';
    if (queue[2] === 'consumers' && !queue[3] && method === 'POST' && pending(ledger, 'consumer', 'http_pull')
      && ledger.state.pending.some(r => r.kind === 'consumer' && r.parentId === queue[1])
      && equal(body, { type: 'http_pull', settings: { visibility_timeout_ms: 10000 } })) return 'consumer-create';
    if (queue[2] === 'consumers' && queue[3] && method === 'DELETE' && body === null
      && owned(ledger, 'consumer', queue[3])?.parentId === queue[1]) return 'delete';
    if (queue[2] === 'messages/pull' && !queue[3] && method === 'POST'
      && equal(body, { batch_size: LIMITS.queueBatchSize, visibility_timeout_ms: 10000 })) return 'pull';
    if (queue[2] === 'messages/ack' && !queue[3] && method === 'POST' && exactKeys(body, ['acks', 'retries'])
      && Array.isArray(body.retries) && body.retries.length === 0 && Array.isArray(body.acks)
      && body.acks.length > 0 && body.acks.length <= LIMITS.queueBatchSize
      && body.acks.every(ack => exactKeys(ack, ['lease_id']) && lease(ack.lease_id))) return 'ack';
  }
  if (suffix === '/event_subscriptions/subscriptions' && method === 'POST' && pending(ledger, 'subscription', plan.resources.eventSubscription)
    && equal(body, { name: plan.resources.eventSubscription, enabled: true,
      source: { type: 'artifacts.repo', namespace: plan.target.namespace, repo_name: plan.resources.repositories[0] },
      events: ['pushed'], destination: { type: 'queues.queue', queue_id: body?.destination?.queue_id } })
    && owned(ledger, 'queue', body.destination.queue_id)) return 'subscription-create';
  const subscription = suffix.match(/^\/event_subscriptions\/subscriptions\/([A-Za-z0-9_-]{1,128})$/);
  if (subscription && method === 'DELETE' && body === null && owned(ledger, 'subscription', subscription[1])) return 'delete';
  fail();
}
export function validateBridgeRequest(request, { plan, ledger, now = Date.now() }) {
  let expected;
  try { expected = makePlan({ runId: plan.runId, ...plan.target, now: Date.parse(plan.createdAt) }); } catch { fail(); }
  if (!equal(expected, plan) || !equal(plan, ledger.state.plan)) fail();
  if (!exactKeys(request, ['version', 'requestId', 'runId', 'planDigest', 'createdAt', 'expiresAt', 'phase', 'method', 'path', 'body'])
    || request.version !== 1 || !uuid.test(request.requestId) || request.runId !== plan.runId || request.planDigest !== plan.digest
    || ledger.state.plan.digest !== plan.digest || Buffer.byteLength(JSON.stringify(request)) > BRIDGE_LIMITS.maxRequestBytes) fail();
  const created = Date.parse(request.createdAt), expires = Date.parse(request.expiresAt), started = Date.parse(ledger.state.startedAt);
  const normalEnd = Math.min(Date.parse(plan.expiresAt), started + LIMITS.runSeconds * 1000);
  if (!Number.isFinite(now) || !Number.isFinite(started) || started < Date.parse(plan.createdAt) || started >= Date.parse(plan.expiresAt)
    || ledger.state.version !== 1 || ledger.state.status !== 'started'
    || !Number.isFinite(created) || !Number.isFinite(expires) || created < started
    || created > now || now >= expires || expires <= created || expires - created > LIMITS.apiSeconds * 1000
    || expires > normalEnd + (request.phase === 'cleanup' ? LIMITS.cleanupSeconds * 1000 : 0)) throw new Error('bridge_expired');
  return validateBridgeOperation(request, { plan, ledger });
}
function safeEvent(body, plan) {
  let event = body;
  if (typeof body === 'string') { try { event = JSON.parse(body); } catch { try { event = JSON.parse(Buffer.from(body, 'base64').toString()); } catch { fail(); } } }
  if (!event || event.type !== 'cf.artifacts.repo.pushed' || event.source?.namespace !== plan.target.namespace
    || event.source?.repoName !== plan.resources.repositories[0] || !plan.syntheticData.refs.includes(event.payload?.ref)) fail();
  const payload = { ref: event.payload.ref };
  for (const key of ['before', 'after']) {
    if (event.payload[key] !== undefined) {
      if (typeof event.payload[key] !== 'string' || event.payload[key].length !== 40 || !/^[a-f0-9]{40}$/.test(event.payload[key])) fail();
      payload[key] = event.payload[key];
    }
  }
  const timestamp = event.metadata?.eventTimestamp;
  if (timestamp !== undefined && (typeof timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp)) fail();
  return { type: event.type, source: { namespace: event.source.namespace, repoName: event.source.repoName }, payload,
    ...(timestamp === undefined ? {} : { metadata: { eventTimestamp: timestamp } }) };
}
// Select only documented fields needed by this smoke. Never persist provider headers/errors/diagnostics.
export function sanitizeBridgeValue(kind, status, value, plan) {
  if (!Number.isInteger(status) || status < 200 || status > 599 || typeof value?.success !== 'boolean') fail();
  if (status < 200 || status >= 300 || !value.success) return { success: false, result: null };
  const result = value.result;
  if (kind === 'queue-list') {
    if (!Array.isArray(result) || result.length > 1000 || !result.every(q => typeof q.queue_name === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(q.queue_name))
      || !Number.isSafeInteger(value.result_info?.total_pages) || value.result_info.total_pages < 0
      || !Number.isSafeInteger(value.result_info?.total_count) || value.result_info.total_count < 0) fail();
    return { success: true, result: result.map(q => ({ queue_name: q.queue_name })), result_info: { total_pages: value.result_info.total_pages, total_count: value.result_info.total_count } };
  }
  if (kind === 'queue-create') { if (!id(result?.queue_id) || result.queue_name !== plan.resources.queue) fail(); return { success: true, result: { queue_id: result.queue_id, queue_name: result.queue_name } }; }
  if (kind === 'consumer-create') { if (!id(result?.consumer_id)) fail(); return { success: true, result: { consumer_id: result.consumer_id } }; }
  if (kind === 'subscription-create') { if (!id(result?.id)) fail(); return { success: true, result: { id: result.id } }; }
  if (kind === 'pull') {
    if (!Array.isArray(result?.messages) || result.messages.length > LIMITS.queueBatchSize || !result.messages.every(m => lease(m.lease_id))) fail();
    return { success: true, result: { messages: result.messages.map(m => ({ lease_id: m.lease_id, body: safeEvent(m.body, plan) })) } };
  }
  if (kind === 'delete' && status === 202) throw new Error('bridge_cleanup_unconfirmed');
  if (kind === 'delete' || kind === 'ack') return { success: true, result: null };
  fail();
}
export function makeBridgeResponse(request, providerResponse, context) {
  const kind = validateBridgeRequest(request, context), value = sanitizeBridgeValue(kind, providerResponse.status, providerResponse.value, context.plan);
  const response = { version: 1, requestId: request.requestId, requestDigest: hash(request), runId: request.runId,
    planDigest: request.planDigest, method: request.method, path: request.path,
    completedAt: new Date(context.now ?? Date.now()).toISOString(), status: providerResponse.status, value };
  if (Buffer.byteLength(JSON.stringify(response)) > BRIDGE_LIMITS.maxResponseBytes) fail();
  return response;
}
export function validateBridgeResponse(response, request, context) {
  if (!exactKeys(response, ['version', 'requestId', 'requestDigest', 'runId', 'planDigest', 'method', 'path', 'completedAt', 'status', 'value'])
    || response.version !== 1 || response.requestId !== request.requestId || response.requestDigest !== hash(request)
    || response.runId !== request.runId || response.planDigest !== request.planDigest || response.method !== request.method || response.path !== request.path
    || Date.parse(response.completedAt) < Date.parse(request.createdAt) || !(Date.parse(response.completedAt) <= (context.now ?? Date.now()))) fail();
  const normalized = makeBridgeResponse(request, response, { ...context, now: Date.parse(response.completedAt) });
  validateBridgeRequest(request, context); // A timely responder cannot make a late response usable.
  if (!equal(normalized, response)) fail();
  return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.value };
}
async function writeExclusiveJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, path); } finally { await unlink(temporary); }
}
async function readPrivateJson(path, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o777) !== 0o600 || process.getuid && info.uid !== process.getuid()) fail();
    // link+unlink publishes exclusively without overwriting. Wait out its tiny two-link interval.
    if (info.nlink !== 1) { const error = new Error('bridge_not_ready'); error.code = 'EAGAIN'; throw error; }
    const bytes = Buffer.alloc(maxBytes + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) fail();
    try { return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); } catch { fail(); }
  } finally { await handle.close(); }
}
export async function createFileControlBridge({ root, plan, ledger, now = Date.now }) {
  await assertPrivateDirectory(root);
  const directory = join(root, plan.runId); await mkdir(directory, { mode: 0o700 }); // Exclusive run, never reuse.
  const request = async ({ method, path, body, phase, deadline }) => {
    await assertPrivateDirectory(directory);
    const created = now(), item = { version: 1, requestId: randomUUID(), runId: plan.runId, planDigest: plan.digest,
      createdAt: new Date(created).toISOString(), expiresAt: new Date(Math.min(deadline, created + LIMITS.apiSeconds * 1000)).toISOString(),
      phase, method, path, body: body ?? null };
    validateBridgeRequest(item, { plan, ledger, now: created });
    await writeExclusiveJson(join(directory, `${item.requestId}.request.json`), item);
    while (now() < Date.parse(item.expiresAt)) {
      let response;
      try { response = await readPrivateJson(join(directory, `${item.requestId}.response.json`), BRIDGE_LIMITS.maxResponseBytes); }
      catch (error) { if (!['ENOENT', 'EAGAIN'].includes(error.code)) throw new Error('bridge_invalid'); }
      if (response) return validateBridgeResponse(response, item, { plan, ledger, now: now() });
      await new Promise(resolve => setTimeout(resolve, Math.min(BRIDGE_LIMITS.pollMs, Math.max(1, Date.parse(item.expiresAt) - now()))));
    }
    throw new Error('bridge_timeout');
  };
  return { directory, request };
}
export async function listBridgeRequests({ directory, plan, ledger, now = Date.now() }) {
  await assertPrivateDirectory(directory);
  const files = await readdir(directory), requests = [];
  for (const file of files) {
    const requestId = file.replace(/\.request\.json$/, '');
    if (!uuid.test(requestId) || file !== `${requestId}.request.json` || files.includes(`${requestId}.response.json`) || files.includes(`${requestId}.claim.json`)) continue;
    let request;
    try { request = await readPrivateJson(join(directory, file), BRIDGE_LIMITS.maxRequestBytes); } catch (error) { if (error.code === 'EAGAIN') continue; throw error; }
    try { validateBridgeRequest(request, { plan, ledger, now }); } catch (error) { if (error.message === 'bridge_expired') continue; throw error; }
    if (request.requestId !== requestId) fail(); requests.push(request);
  }
  return requests;
}
export async function claimBridgeRequests({ directory, plan, ledger, now = Date.now() }) {
  const requests = await listBridgeRequests({ directory, plan, ledger, now }), claimed = [];
  for (const request of requests) {
    validateBridgeRequest(request, { plan, ledger, now });
    const claim = { version: 1, requestId: request.requestId, requestDigest: hash(request), claimedAt: new Date(now).toISOString() };
    try { await writeExclusiveJson(join(directory, `${request.requestId}.claim.json`), claim); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    claimed.push(request);
  }
  // Claim loss is an unknown outcome, not permission to retry. Claims are never automatically removed.
  return claimed;
}
export async function writeBridgeResponse({ directory, requestId, providerResponse, plan, ledger, now = Date.now() }) {
  await assertPrivateDirectory(directory); if (!uuid.test(requestId)) fail();
  const request = await readPrivateJson(join(directory, `${requestId}.request.json`), BRIDGE_LIMITS.maxRequestBytes);
  if (request.requestId !== requestId) fail();
  const claim = await readPrivateJson(join(directory, `${requestId}.claim.json`), BRIDGE_LIMITS.maxRequestBytes);
  if (!exactKeys(claim, ['version', 'requestId', 'requestDigest', 'claimedAt']) || claim.version !== 1 || claim.requestId !== requestId
    || claim.requestDigest !== hash(request) || Date.parse(claim.claimedAt) < Date.parse(request.createdAt) || !(Date.parse(claim.claimedAt) <= now)) fail();
  const response = makeBridgeResponse(request, providerResponse, { plan, ledger, now });
  await writeExclusiveJson(join(directory, `${requestId}.response.json`), response);
  return { requestId, status: response.status };
}
// Operational helper: reads only the explicitly selected non-secret plan/ledger/bridge.
export async function bridgeMain(argv = process.argv.slice(2), { stdin = process.stdin, log = console.log } = {}) {
  try {
    const [mode, ...args] = argv, options = {};
    if (!['--pending', '--claim', '--respond'].includes(mode) || args.length % 2) fail();
    for (let i = 0; i < args.length; i += 2) { if (!['--bridge-dir', '--plan-file', '--ledger-file', '--request-id'].includes(args[i]) || options[args[i]]) fail(); options[args[i]] = args[i + 1]; }
    const directory = options['--bridge-dir'], plan = await readPrivateJson(options['--plan-file'], 32768), ledger = { state: await readPrivateJson(options['--ledger-file'], 262144) };
    if (mode !== '--respond') { if (options['--request-id']) fail(); log(JSON.stringify(await (mode === '--claim' ? claimBridgeRequests : listBridgeRequests)({ directory, plan, ledger }))); }
    else {
      let input = ''; for await (const chunk of stdin) { input += chunk; if (Buffer.byteLength(input) > BRIDGE_LIMITS.maxResponseBytes) fail(); }
      const providerResponse = JSON.parse(input); if (!exactKeys(providerResponse, ['status', 'value'])) fail();
      log(JSON.stringify(await writeBridgeResponse({ directory, requestId: options['--request-id'], providerResponse, plan, ledger })));
    }
    return 0;
  } catch { log('BRIDGE BLOCKED: invalid, expired, or unavailable request/response'); return 2; }
}
if (isMain(import.meta.url)) process.exitCode = await bridgeMain();
