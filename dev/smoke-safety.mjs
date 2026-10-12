// SPDX-License-Identifier: Apache-2.0
// This module never contacts Cloudflare. Planning and subprocess guards are local.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPrivateDirectory } from './smoke-auth.mjs';
import { scopedGitTransport, categorizeGitFailure, safeGitPhase, GIT_FAILURE_CATEGORIES } from './smoke-transport.mjs';

export const LIMITS = Object.freeze({ tokenTtlSeconds: 600, runSeconds: 300, cleanupSeconds: 120,
  apiSeconds: 10, gitSeconds: 30, eventSeconds: 60, maxApiRequests: 160, maxGitNetworkCommands: 7,
  maxCleanupRequests: 60, maxQueuePulls: 30, queueBatchSize: 20, maxOutputBytes: 1048576 });
const UNVERIFIED = 'UNVERIFIED';
const safeName = /^[a-z0-9][a-z0-9-]{0,39}$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function makePlan({ runId = randomBytes(8).toString('hex'), namespace = UNVERIFIED,
  accountId = UNVERIFIED, accountName = UNVERIFIED, accountPlan = UNVERIFIED,
  jurisdiction = UNVERIFIED, now = Date.now() } = {}) {
  if (!safeName.test(runId)) throw new Error('invalid_run_id');
  if (namespace !== UNVERIFIED && !safeName.test(namespace)) throw new Error('invalid_namespace');
  const canonical = `as1-${runId}`, fork = `${canonical}--x--y`, queue = `${canonical}-events`;
  const plan = { version: 2, runId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
    target: { accountId, accountName, accountPlan, namespace, jurisdiction },
    resources: { repositories: [canonical, fork], queue, httpPullConsumers: 1, eventSubscription: `${canonical}-pushed`,
      counts: { namespaces: 0, repositories: 2, queues: 1, consumers: 1, subscriptions: 1, explicitTokens: 3, automaticTokens: 2 },
      explicitTokens: [{ repo: canonical, scope: 'write', ttl: 600 }, { repo: canonical, scope: 'read', ttl: 600 }, { repo: fork, scope: 'write', ttl: 600 }],
      automaticTokens: 'Create/fork each return a write token with server-selected expiry; discover IDs and revoke immediately, before explicit minting.' },
    limits: { ...LIMITS },
    syntheticData: { author: 'Smoke <smoke@example.invalid>', file: 'README.md', body: 'Artifacts smoke\n', notes: ['Artifacts why'],
      commits: ['Smoke seed', 'Smoke candidate x', 'Smoke candidate z', 'Smoke publication', 'Smoke rejected publication', 'Smoke publication manifest'],
      directoryFiles: ['.heddle-agents.json', '.heddle-publication.json'], directoryAgents: [], manifest: 'Synthetic format-1/domain heddle-smoke-transport-v1 transport fixture: exact commit IDs, previous main, proof refs and local verification; not a production resolver manifest; no application data.',
      refs: ['refs/heads/main', 'refs/heads/candidates/x/y', 'refs/heads/candidates/z/y', 'refs/notes/heddle-why', 'refs/heads/heddle/agents'], maxGitNetworkCommands: LIMITS.maxGitNetworkCommands },
    publication: { protocol: 'recoverable-main-last-v1', atomic: false, auxiliaryRefs: 'Pending until the exact manifest, proof OIDs and expected-old main CAS are confirmed; partial auxiliary staging is possible.',
      gitNetworkCommands: ['seed_main', 'stage_proofs', 'staged_refs', 'main_cas', 'stale_main_cas', 'mirror_clone', 'final_refs'] },
    cost: { verifiedTotal: null, currency: 'USD', proposedCap: 1, authorized: false, enforceableBillingCap: false },
    authorization: 'NOT AUTHORIZED by generating this plan. Separate account, cost, credential, token-creation and synthetic-resource deletion approval is required.',
    cleanup: 'Only successfully created IDs recorded by this run; verify repository ID before name-addressed mutations. Unknown outcomes require manual reconciliation. Keep the non-secret ledger.' };
  return { ...plan, digest: digest(plan) };
}
export function validateLivePlan(plan, runId, env = process.env, now = Date.now(), { authMode = 'api-token' } = {}) {
  if (!plan || !runId || plan.runId !== runId) throw new Error('planned_run_id_required');
  const expected = makePlan({ runId, ...plan.target, now: Date.parse(plan.createdAt) });
  if (JSON.stringify(expected) !== JSON.stringify(plan)) throw new Error('plan_changed_regenerate_and_review');
  if (now < Date.parse(plan.createdAt) || now >= Date.parse(plan.expiresAt)) throw new Error('plan_expired');
  if (!/^[a-f0-9]{32}$/i.test(plan.target.accountId) || !safeName.test(plan.target.namespace)
    || !plan.target.accountName || plan.target.accountName === UNVERIFIED
    || plan.target.accountPlan !== 'Workers Paid' || !['eu', 'us', 'unrestricted'].includes(plan.target.jurisdiction)) throw new Error('unverified_target');
  if (!['api-token', 'wrangler-oauth'].includes(authMode)) throw new Error('invalid_auth_mode');
  if (env.CF_ACCOUNT_ID !== plan.target.accountId || authMode === 'api-token' && !env.CLOUDFLARE_API_TOKEN) throw new Error('approved_account_credentials_required');
  return plan;
}
// Reserve before spawning any remote Git command, including rejected probes.
// Failed commands consume their slot; there is no hidden retry budget.
export function createGitNetworkBudget(max = LIMITS.maxGitNetworkCommands) {
  if (!Number.isInteger(max) || max < 0 || max > LIMITS.maxGitNetworkCommands) throw new Error('git_network_command_limit');
  let used = 0;
  return Object.freeze({ get used() { return used; }, max, reserve() {
    if (used >= max) throw new Error('git_network_command_limit');
    return ++used;
  }, requireComplete() { if (used !== max) throw new Error('git_network_count_mismatch'); } });
}
export function safeGitEnv(home, token, remote, transport) {
  const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const config = [['protocol.version', '1'], ['credential.helper', ''], ['core.hooksPath', '/dev/null'],
    ['http.followRedirects', 'false'], ['http.lowSpeedLimit', '1'], ['http.lowSpeedTime', '20']];
  if (token) config.push([`http.${remote}.extraheader`, `Authorization: Bearer ${token}`]);
  if (transport) config.push(...scopedGitTransport(transport, remote, home));
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  return env;
}
export function validateRemote(remote, { accountId, namespace, name, local = false }) {
  let url; try { url = new URL(remote); } catch { throw new Error('invalid_remote'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== `/git/${namespace}/${name}.git`
    || (local ? url.protocol !== 'http:' || url.hostname !== '127.0.0.1' : url.protocol !== 'https:' || url.host !== `${accountId}.artifacts.cloudflare.net`)) throw new Error('unapproved_remote');
  return remote;
}
export function boundedGit(args, cwd, { home, token, remote, transport, phase = 'local_setup', timeoutMs = LIMITS.gitSeconds * 1000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const errorFor = category => Object.assign(new Error(category), { gitPhase: safeGitPhase(phase) });
    let child;
    try { child = spawnImpl('git', args, { cwd, env: safeGitEnv(home, token, remote, transport), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(errorFor(error?.message === 'git_transport_config_invalid' ? error.message : 'git_spawn_failed')); return; }
    let length = 0, failure, diagnostics = '', diagnosticBytes = 0, settled = false; const chunks = [];
    const kill = reason => { failure ??= reason; try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    const timer = setTimeout(() => kill('git_timeout'), Math.max(1, timeoutMs));
    const collect = (data, keep) => {
      length += data.length;
      if (length > LIMITS.maxOutputBytes) kill('git_output_limit');
      else if (keep) chunks.push(data);
      else if (diagnosticBytes < 16384) { const part = data.subarray(0, 16384 - diagnosticBytes); diagnosticBytes += part.length; diagnostics += part.toString('utf8'); }
    };
    child.stdout.on('data', b => collect(b, true)); child.stderr.on('data', b => collect(b, false));
    child.on('error', () => { if (settled) return; settled = true; clearTimeout(timer); diagnostics = ''; reject(errorFor('git_spawn_failed')); });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      const category = failure ?? (code !== 0 ? categorizeGitFailure(diagnostics) : undefined); diagnostics = '';
      if (category) reject(errorFor(category)); else resolve(Buffer.concat(chunks).toString());
    });
    child.stdin.on('error', () => {}); child.stdin.end();
  });
}
export async function createLedger(root, plan) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(root);
  const path = join(root, `${plan.runId}.json`), handle = await open(path, 'wx', 0o600);
  const state = { version: 1, plan, startedAt: new Date().toISOString(), status: 'started', resources: [], pending: [], cleanupFailures: [], outcomes: [] };
  try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  const save = async () => {
    await assertPrivateDirectory(root);
    const next = `${path}.${randomBytes(16).toString('hex')}.next`, handle = await open(next, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
      await assertPrivateDirectory(root); await rename(next, path);
    } catch (error) { await unlink(next).catch(() => {}); throw error; }
  };
  return { path, state, save };
}
export function safeFailure(error) {
  const allowed = new Set(['invalid_run_id', 'invalid_namespace', 'planned_run_id_required', 'plan_changed_regenerate_and_review', 'plan_expired', 'unverified_target', 'approved_account_credentials_required', 'ledger_directory_required', 'invalid_remote', 'unapproved_remote', 'git_timeout', 'git_output_limit', 'git_spawn_failed', 'git_failed', 'run_deadline', 'api_request_limit', 'invalid_resource_id', 'unowned_resource', 'resource_identity_changed', 'namespace_mismatch', 'preexisting_resource', 'preflight_inventory_incomplete', 'unplanned_resource', 'created_name_mismatch', 'unexpected_token_inventory', 'unplanned_token', 'token_expiry_mismatch', 'ref_check_failed', 'atomic_ref_check_failed', 'proof_ref_check_failed', 'stale_main_cas_accepted', 'rebuilt_notes_accepted', 'clone_verification_failed', 'git_network_command_limit', 'git_network_count_mismatch', 'notes_rejected', 'atomic_rejected', 'event_timeout', 'duplicate_argument', 'invalid_argument', 'choose_plan_fake_or_live']);
  const authBridge = new Set(['invalid_auth_mode', 'private_directory_required', 'private_oauth_home_required', 'oauth_cli_version_mismatch', 'oauth_output_invalid', 'oauth_timeout', 'oauth_output_limit', 'oauth_spawn_failed', 'oauth_command_failed', 'oauth_bridge_required', 'bridge_invalid', 'bridge_expired', 'bridge_timeout', 'bridge_cleanup_unconfirmed', 'unapproved_control_path']);
  return allowed.has(error?.message) || authBridge.has(error?.message) || GIT_FAILURE_CATEGORIES.includes(error?.message)
    || ['git_transport_config_invalid', 'git_transport_ca_mismatch'].includes(error?.message)
    || /^control_plane_[1-5][0-9]{2}$/.test(error?.message) ? error.message : 'smoke_failed';
}
