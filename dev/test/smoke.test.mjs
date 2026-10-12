// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requireRefs, requireExactRefs, main, smoke, makePlan, validateLivePlan } from '../smoke-artifacts.mjs';
import { createLedger, safeGitEnv, boundedGit, validateRemote, safeFailure, createGitNetworkBudget, LIMITS } from '../smoke-safety.mjs';
import { createControlPlane } from '../smoke-control.mjs';
const accountId = 'a'.repeat(32);
const env = { CF_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'API-SECRET-NEVER-LOG' };
const completePlan = (overrides = {}) => makePlan({ runId: 'test-local-only', accountId, accountName: 'Synthetic account', accountPlan: 'Workers Paid', namespace: 'heddle-demo', jurisdiction: 'unrestricted', ...overrides });
const response = (result, status = 200, extra = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ success: status >= 200 && status < 300, result, ...extra }) });
function mockCloud(plan, { existingRepo = false, existingQueue = false, inventoryUnknown = false, deleteFailure = false, createUnknown = false } = {}) {
  const calls = [], repos = new Map(), tokens = new Map(), base = `/artifacts/namespaces/${plan.target.namespace}`;
  if (existingRepo) repos.set(plan.resources.repositories[0], { id: 'preexisting-id', name: plan.resources.repositories[0] });
  const fetchImpl = async (url, opts) => {
    const path = url.split(`/accounts/${accountId}`)[1], method = opts.method, body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path, method, body });
    assert.equal(opts.redirect, 'error');
    if (path === base && method === 'GET') return response({ namespace: 'heddle-demo', jurisdiction: null });
    if (path === '/queues' && method === 'GET') return response(existingQueue ? [{ queue_name: plan.resources.queue }] : [], 200, { result_info: { total_pages: inventoryUnknown ? 2 : 1, total_count: existingQueue ? 1 : 0 } });
    const repoMatch = path.match(/\/repos\/([^/?]+)$/);
    if (repoMatch && method === 'GET') return repos.has(repoMatch[1]) ? response(repos.get(repoMatch[1])) : response(null, 404);
    if (path === `${base}/repos` && method === 'POST') {
      if (createUnknown) throw new Error('NETWORK-SECRET-DO-NOT-PRINT');
      const repo = { id: 'created-repo-id', name: body.name, remote: `https://${accountId}.artifacts.cloudflare.net/git/heddle-demo/${body.name}.git`, token: 'BOOTSTRAP-SECRET-NEVER-LOG' };
      repos.set(body.name, repo); tokens.set('bootstrap-id', { id: 'bootstrap-id', scope: 'write', expires_at: new Date(Date.now() + 86400000).toISOString() }); return response(repo);
    }
    if (path.endsWith('/tokens?state=active&per_page=100&page=1')) return response([...tokens.values()], 200, { result_info: { total_pages: 1, total_count: tokens.size } });
    if (path === `${base}/tokens` && method === 'POST') {
      const token = { id: `explicit-${body.scope}`, scope: body.scope, expires_at: new Date(Date.now() + 600000).toISOString() };
      tokens.set(token.id, token); return response({ ...token, plaintext: 'EXPLICIT-SECRET-NEVER-LOG' });
    }
    if (path.startsWith(`${base}/tokens/`) && method === 'DELETE') {
      if (deleteFailure) return response(null, 503);
      tokens.delete(path.split('/').at(-1)); return response({ id: path.split('/').at(-1) });
    }
    if (repoMatch && method === 'DELETE') { repos.delete(repoMatch[1]); return response({ id: 'created-repo-id' }, 202); }
    throw new Error(`Unexpected mock call ${method} ${path}`);
  };
  return { fetchImpl, calls, repos, tokens, base };
}
async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'smoke-unit-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const plan = completePlan(), ledger = await createLedger(dir, plan), mock = mockCloud(plan, options);
  const control = createControlPlane({ plan, ledger, fetchImpl: mock.fetchImpl, apiToken: env.CLOUDFLARE_API_TOKEN });
  return { dir, plan, ledger, control, ...mock };
}
test('A-S1 ref evidence cannot pass with a missing ref or a substring match', () => {
  const refs = `${'a'.repeat(40)}\trefs/heads/main\n${'b'.repeat(40)}\trefs/notes/heddle-why\n`;
  requireRefs(refs, ['refs/heads/main', 'refs/notes/heddle-why']);
  assert.throws(() => requireRefs(refs, ['refs/heads/candidates/x/y']), /ref_check_failed/);
  assert.throws(() => requireRefs(refs, ['refs/notes/heddle']), /ref_check_failed/);
});
test('--plan is local-only with stable names, explicit bounds and no credentials', async () => {
  let calls = 0; const out = [];
  const status = await main(['--plan', '--run-id', 'review-20261010'], { log: s => out.push(s), env, fetchImpl: async () => { calls++; throw new Error('no network'); } });
  assert.equal(status, 0); assert.equal(calls, 0); const plan = JSON.parse(out.join(''));
  assert.deepEqual(plan.resources.repositories, ['as1-review-20261010', 'as1-review-20261010--x--y']);
  assert.equal(plan.resources.counts.automaticTokens, 2); assert.equal(plan.resources.counts.explicitTokens, 3);
  assert.equal(plan.limits.runSeconds, 300); assert.equal(plan.limits.cleanupSeconds, 120);
  assert.equal(plan.target.accountId, 'UNVERIFIED'); assert.equal(plan.cost.authorized, false);
  assert(!JSON.stringify(plan).includes(env.CLOUDFLARE_API_TOKEN));
});
test('live mode refuses absent, unknown, expired, changed and wrong-account plans without network', async () => {
  const plan = completePlan(), calls = [];
  assert.equal(validateLivePlan(plan, plan.runId, env), plan);
  for (const [p, id, credentials, pattern] of [[undefined, undefined, env, /planned_run_id/], [makePlan(), plan.runId, env, /planned_run_id/],
    [makePlan({ runId: plan.runId }), plan.runId, env, /unverified_target/], [completePlan({ now: Date.now() - 3600001 }), plan.runId, env, /plan_expired/],
    [{ ...plan, limits: { ...plan.limits, tokenTtlSeconds: 86400 } }, plan.runId, env, /plan_changed/], [plan, plan.runId, { ...env, CF_ACCOUNT_ID: 'b'.repeat(32) }, /approved_account/]]) {
    assert.throws(() => validateLivePlan(p, id, credentials), pattern);
    assert.equal(await smoke({ plan: p, runId: id, env: credentials, ledgerDir: '/not-used', fetchImpl: async () => calls.push('network'), log: () => {} }), 2);
  }
  assert.deepEqual(calls, []);
});
for (const options of [{ existingRepo: true }, { existingQueue: true }, { inventoryUnknown: true }]) test(`preflight refuses existing or unknown inventory: ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options); await assert.rejects(f.control.preflight(), /preexisting_resource|preflight_inventory_incomplete/);
  assert(f.calls.every(c => c.method === 'GET')); assert.deepEqual(f.ledger.state.resources, []);
  assert.equal(await f.control.cleanupResources(() => {}), true); assert(f.calls.every(c => c.method === 'GET'));
});
test('ledger records IDs without token plaintext and refuses reusing a run ID', async t => {
  const f = await fixture(t); await f.control.preflight();
  const name = f.plan.resources.repositories[0]; await f.control.create('repo', name, `${f.base}/repos`, { name });
  await f.control.revokeTokens(name); await f.control.mint(name, 'write'); await f.control.mint(name, 'read');
  assert.equal(f.tokens.size, 2); assert.equal(await f.control.cleanupResources(() => {}), true); assert.equal(f.tokens.size, 0);
  assert.equal(f.ledger.state.resources[0].tokens.length, 3); assert.equal(f.ledger.state.resources[0].status, 'deleted');
  const content = await readFile(f.ledger.path, 'utf8'); assert(!content.includes('SECRET')); assert(content.includes('bootstrap-id')); assert(content.includes('explicit-write'));
  assert.equal((await stat(f.ledger.path)).mode & 0o777, 0o600);
  await assert.rejects(createLedger(f.dir, f.plan), { code: 'EEXIST' });
  const deletes = f.calls.filter(c => c.method === 'DELETE').map(c => c.path);
  assert(deletes.indexOf(`${f.base}/tokens/explicit-read`) < deletes.indexOf(`${f.base}/repos/${name}`));
});
test('unknown create outcome stays pending and is never adopted or deleted by name', async t => {
  const f = await fixture(t, { createUnknown: true }), name = f.plan.resources.repositories[0]; await f.control.preflight();
  await assert.rejects(f.control.create('repo', name, `${f.base}/repos`, { name }));
  const out = []; assert.equal(await f.control.cleanupResources(s => out.push(s)), false);
  assert.equal(f.ledger.state.pending.length, 1); assert(!f.calls.some(c => c.method === 'DELETE')); assert(out.some(s => s.includes('CLEANUP UNKNOWN')));
});
test('replacement IDs are never mutated or deleted during cleanup', async t => {
  const f = await fixture(t), name = f.plan.resources.repositories[0];
  await f.control.create('repo', name, `${f.base}/repos`, { name }); f.repos.set(name, { id: 'replacement-id', name });
  await assert.rejects(f.control.mint(name, 'write'), /resource_identity_changed/);
  const out = []; assert.equal(await f.control.cleanupResources(s => out.push(s)), false);
  assert(!f.calls.some(c => c.method === 'DELETE')); assert(out.some(s => s.includes('resource_identity_changed')));
});
test('cleanup failure is retained, printed and prevents a successful smoke exit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'smoke-failed-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const plan = completePlan(), mock = mockCloud(plan, { deleteFailure: true }), out = [];
  const status = await smoke({ plan, runId: plan.runId, ledgerDir: dir, env, fetchImpl: mock.fetchImpl, log: s => out.push(s) });
  assert.equal(status, 1); assert(out.some(s => s.startsWith('CLEANUP FAIL'))); assert(!out.some(s => s.startsWith('A-S1 PASS')));
  const ledger = JSON.parse(await readFile(join(dir, `${plan.runId}.json`), 'utf8'));
  assert.equal(ledger.status, 'failed_or_cleanup_incomplete'); assert.equal(ledger.cleanupFailures.length, 1); assert(!JSON.stringify(ledger).includes('SECRET'));
});
test('Git environment excludes API credentials, user helpers and tracing; remotes reject secret URLs', async () => {
  const gitEnv = safeGitEnv('/tmp/synthetic-home', 'repo-secret', 'https://example.invalid/repo.git');
  assert.equal(gitEnv.CLOUDFLARE_API_TOKEN, undefined); assert.equal(gitEnv.CF_ACCOUNT_ID, undefined); assert.equal(gitEnv.GIT_TRACE, undefined);
  assert.equal(gitEnv.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(gitEnv.GIT_CONFIG_VALUE_3, 'false');
  const remote = `https://${accountId}.artifacts.cloudflare.net/git/heddle-demo/repo.git`, target = { accountId, namespace: 'heddle-demo', name: 'repo' };
  assert.equal(validateRemote(remote, target), remote);
  for (const bad of [remote + '?token=secret', remote.replace('https://', 'https://secret@'), remote.replace(accountId, 'foreign'), 'file:///tmp/repo']) assert.throws(() => validateRemote(bad, target), /unapproved_remote/);
  assert.equal(safeFailure(new Error('SECRET_LEAK')), 'smoke_failed');
});
test('bounded Git kills a timed-out process without reflecting command output', async () => {
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream'); let killed = false;
  const spawnImpl = (_bin, args, opts) => { assert(!args.join(' ').includes('repo-secret')); assert(!JSON.stringify(opts.env).includes('API-SECRET'));
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { killed = true; child.emit('close', 1); }; return child; };
  await assert.rejects(boundedGit(['status'], '/tmp', { home: '/tmp', token: 'repo-secret', remote: 'https://example.invalid/repo', timeoutMs: 5, spawnImpl }), /git_timeout/); assert(killed);
});
test('local no-atomic fake verifies main-last CAS, stale rejection, fresh clone and exact final refs', async () => {
  const out = []; assert.equal(await smoke({ local: true, log: s => out.push(s) }), 0);
  assert(out.includes('PASS main-last expected-old CAS'));
  assert(out.includes('PASS stale expected-old main CAS rejected'));
  assert(out.includes('PASS fresh mirror clone, strict fsck, exact synthetic history, trees, note and manifest contents'));
  assert(out.includes('GIT NETWORK COMMANDS 7/7'));
  const timings = out.filter(line => line.startsWith('TIMING GIT ')).map(line => JSON.parse(line.slice('TIMING GIT '.length)));
  assert.equal(timings.length, 7); assert.equal(timings.filter(sample => sample.outcome === 'failure').length, 1);
  assert(timings.every(sample => Number.isFinite(sample.elapsed_ms) && sample.elapsed_ms >= 0));
  assert.equal(timings.find(sample => sample.phase === 'stale_main_cas').expected_rejection, true);
  const fixture = JSON.parse(out.find(line => line.startsWith('FIXTURE ')).slice('FIXTURE '.length));
  assert.equal(fixture.readme_bytes, 16); assert.equal(fixture.main_history_commit_count, 4); assert(fixture.reachable_object_count > 4);
  assert(fixture.reachable_uncompressed_object_bytes > fixture.manifest_bytes);
  const queue = JSON.parse(out.find(line => line.startsWith('TIMING QUEUE ')).slice('TIMING QUEUE '.length));
  assert.equal(queue.outcome, 'observed'); assert(queue.observation_delay_ms >= 0);
  const run = JSON.parse(out.find(line => line.startsWith('TIMING RUN ')).slice('TIMING RUN '.length));
  assert.equal(run.outcome, 'success'); assert.equal(run.fresh_process, false); assert.equal(run.sample_count, 1);
  assert(out.some(s => s.includes('auxiliary refs pending')));
  assert(!out.some(s => s.includes('atomic multi-ref'))); assert(out.some(s => s.startsWith('LOCAL-SMOKE PASS')));
  assert.equal(await smoke({ local: true, missingRef: true, log: () => {} }), 1);
});
test('missing inventory metadata and missing bootstrap identity fail closed', async t => {
  const f = await fixture(t), noMetadata = async (url, opts) => url.endsWith('/queues') && opts.method === 'GET' ? response([]) : f.fetchImpl(url, opts);
  const blocked = createControlPlane({ plan: f.plan, ledger: f.ledger, fetchImpl: noMetadata, apiToken: env.CLOUDFLARE_API_TOKEN });
  await assert.rejects(blocked.preflight(), /preflight_inventory_incomplete/);
  const name = f.plan.resources.repositories[0]; await f.control.create('repo', name, `${f.base}/repos`, { name }); f.tokens.clear();
  await assert.rejects(f.control.revokeTokens(name), /unexpected_token_inventory/);
  await assert.rejects(f.control.mint(name, 'write'), /unplanned_token/);
});
test('normal API actions stop at plan expiry before fetch', async t => {
  const f = await fixture(t); let now = Date.now(), calls = 0;
  const control = createControlPlane({ plan: f.plan, ledger: f.ledger, now: () => now, apiToken: 'fixture', fetchImpl: async () => { calls++; return response({}); } });
  now = Date.parse(f.plan.expiresAt);
  await assert.rejects(control.api('/queues'), /run_deadline/); assert.equal(calls, 0);
});

test('exact publication refs reject wrong hashes, missing refs and ambiguous duplicate rows', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), ref = 'refs/heads/main';
  assert.equal(requireExactRefs(`${a}\t${ref}\n`, { [ref]: a })[ref], a);
  for (const text of [`${b}\t${ref}\n`, '', `${a}\t${ref}\n${b}\t${ref}\n`, `${a}\t${ref}/other\n`, `${a} ${ref}\n`, `SECRET\t${ref}\n`]) {
    assert.throws(() => requireExactRefs(text, { [ref]: a }), /^Error: proof_ref_check_failed$/);
  }
});
test('network-command budget blocks the eighth command before dispatch and counts rejected commands', () => {
  const budget = createGitNetworkBudget(); let dispatched = 0;
  assert.equal(budget.max, 7); assert.equal(LIMITS.maxGitNetworkCommands, 7);
  assert.throws(() => budget.requireComplete(), /git_network_count_mismatch/);
  for (let i = 0; i < 7; i++) { budget.reserve(); dispatched++; }
  assert.equal(budget.used, 7); budget.requireComplete();
  assert.throws(() => { budget.reserve(); dispatched++; }, /git_network_command_limit/);
  assert.equal(dispatched, 7); assert.equal(budget.used, 7);
  for (const max of [8, -1, 1.5, NaN]) assert.throws(() => createGitNetworkBudget(max), /git_network_command_limit/);
});
test('review plan pins the main-last command sequence and rejects legacy atomic plans', () => {
  const plan = completePlan();
  assert.equal(plan.version, 2); assert.equal(plan.publication.atomic, false);
  assert.deepEqual(plan.publication.gitNetworkCommands, ['seed_main', 'stage_proofs', 'staged_refs', 'main_cas', 'stale_main_cas', 'mirror_clone', 'final_refs']);
  assert.equal(plan.syntheticData.maxGitNetworkCommands, 7); assert.equal(plan.syntheticData.refs.length, 5);
  assert.deepEqual(plan.syntheticData.directoryFiles, ['.heddle-agents.json', '.heddle-publication.json']);
  const legacy = { ...plan, version: 1 };
  assert.throws(() => validateLivePlan(legacy, legacy.runId, env), /plan_changed_regenerate_and_review/);
});
