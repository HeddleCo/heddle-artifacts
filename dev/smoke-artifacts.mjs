// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeArtifacts } from './fake-artifacts/server.mjs';
import { LIMITS, makePlan, validateLivePlan, boundedGit, validateRemote, createLedger, safeFailure, createGitNetworkBudget } from './smoke-safety.mjs';
import { createControlPlane } from './smoke-control.mjs';
import { getPrivateOAuthToken } from './smoke-auth.mjs';
import { createFileControlBridge } from './smoke-bridge.mjs';
import { loadGitTransportConfig, safeGitPhase } from './smoke-transport.mjs';
import { DIRECTORY_REF, MANIFEST_PATH, exactRefs, leasedPushArgs } from '../engine/lib/ordered-publication.mjs';
export { makePlan, validateLivePlan } from './smoke-safety.mjs';
export function requireRefs(output, expected) {
  for (const ref of expected) if (!output.split('\n').some(line => line.split(/\s+/)[1] === ref)) throw new Error('ref_check_failed');
}
// Ref names alone cannot establish a pinned publication. Reject malformed and
// duplicate rows too, so ambiguous readback never becomes evidence.
export function requireExactRefs(output, expected) {
  const tips = Object.create(null);
  for (const line of output.split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]{40})\t([^\s]+)$/.exec(line);
    if (!match || Object.hasOwn(tips, match[2])) throw new Error('proof_ref_check_failed');
    tips[match[2]] = match[1];
  }
  try { exactRefs(tips, expected); }
  catch { throw new Error('proof_ref_check_failed'); }
  return tips;
}
export async function measureGitPhase(phase, operation, recordMetric, { monotonic = () => performance.now() } = {}) {
  const start = monotonic(); let failure;
  try { return await operation(); }
  catch (error) { failure = safeFailure(error); throw error; }
  finally { recordMetric({ phase: safeGitPhase(phase), elapsed_ms: Math.max(0, Math.round((monotonic() - start) * 1000) / 1000),
    outcome: failure ? 'failure' : 'success', ...(failure ? { failure } : {}),
    ...(phase === 'stale_main_cas' && failure === 'git_stale_info' ? { expected_rejection: true } : {}), fresh_git_process: true }); }
}
export function publicationEventTiming(item, { namespace, repoName, before, after, sentAt, sentMonotonic }) {
  const event = item.event;
  if (event?.type !== 'cf.artifacts.repo.pushed' || event.source?.namespace !== namespace || event.source?.repoName !== repoName
    || event.payload?.ref !== 'refs/heads/main' || event.payload?.before !== before || event.payload?.after !== after
    || !Number.isFinite(item.receivedMonotonic) || item.receivedMonotonic < sentMonotonic) return null;
  const reported = event.metadata?.eventTimestamp, timestamp = typeof reported === 'string' && reported.length <= 32 ? Date.parse(reported) : NaN;
  const validTimestamp = Number.isFinite(timestamp) && new Date(timestamp).toISOString() === reported
    && timestamp >= sentAt - 5000 && timestamp <= item.receivedAt + 5000;
  return { outcome: 'observed', observation_delay_ms: Math.round((item.receivedMonotonic - sentMonotonic) * 1000) / 1000,
    cas_started_at: new Date(sentAt).toISOString(), observed_at: new Date(item.receivedAt).toISOString(),
    event_timestamp: validTimestamp ? reported : null,
    event_to_observation_ms: validTimestamp && timestamp <= item.receivedAt ? item.receivedAt - timestamp : null,
    server_clock_verified: false, includes_polling_and_intervening_checks: true };
}
export async function smoke({ local = false, missingRef = false, plan, runId, ledgerDir, localFakeFactory = startFakeArtifacts,
  authMode = 'api-token', oauthHome, oauthXdgConfig, bridgeDir, oauthTokenProvider = getPrivateOAuthToken,
  bridgeFactory = createFileControlBridge, gitTransportConfig, gitTransportLoader = loadGitTransportConfig,
  env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  if (!local) {
    try {
      validateLivePlan(plan, runId, env, Date.now(), { authMode }); if (!ledgerDir) throw new Error('ledger_directory_required');
      if (authMode === 'wrangler-oauth' && (!oauthHome || !bridgeDir)) throw new Error('oauth_bridge_required');
      if (authMode === 'api-token' && (oauthHome || oauthXdgConfig)) throw new Error('invalid_argument');
    }
    catch (error) { log(`A-S1 BLOCKED: ${safeFailure(error)}. Generate and review --plan first; no network request made.`); return 2; }
  }
  plan ??= makePlan({ namespace: 'heddle-demo' });
  const [repoName, forkName] = plan.resources.repositories, namespace = local ? 'heddle-demo' : plan.target.namespace;
  let temp, fake, sink, control, ledger, canonical, failure, queueTiming, mainCasStarted, queueId, transport, exitCode = 1;
  const measurements = { git: [], fixture: null, queue: null, run: null };
  const events = [], outcomes = [], networkBudget = createGitNetworkBudget(plan.syntheticData.maxGitNetworkCommands);
  const record = message => { outcomes.push(message); log(message); };
  const startedMonotonic = performance.now(), started = Date.now(), normalDeadline = Math.min(started + LIMITS.runSeconds * 1000, Date.parse(plan.expiresAt));
  const remaining = () => Math.max(0, normalDeadline - Date.now());
  const git = async (args, cwd, token, remote, phase = 'local_setup') => {
    if (remaining() <= 0) throw new Error('run_deadline');
    try { return await boundedGit(args, cwd, { home: temp, token, remote, transport: remote && !local ? transport : undefined,
      phase, timeoutMs: Math.min(LIMITS.gitSeconds * 1000, remaining()) }); }
    catch (error) { record(`GIT FAIL ${safeGitPhase(error.gitPhase)}: ${safeFailure(error)} (diagnostics suppressed)`); throw error; }
  };
  try {
    temp = await mkdtemp(join(tmpdir(), 'artifacts-smoke-'));
    // The durable, credential-free ledger is created exclusively BEFORE any live read or write.
    if (!local) {
      ledger = await createLedger(resolve(ledgerDir), plan);
      ledger.state.measurements = measurements;
      if (gitTransportConfig) {
        const plannedRemote = `https://${plan.target.accountId}.artifacts.cloudflare.net/git/${namespace}/${repoName}.git`;
        validateRemote(plannedRemote, { accountId: plan.target.accountId, namespace, name: repoName });
        transport = await gitTransportLoader(gitTransportConfig, { remote: plannedRemote, home: temp, platformProxy: env.HTTPS_PROXY });
        ledger.state.gitTransport = { proxy: transport.proxy, caFile: transport.sourceCaFile, caSha256: transport.caSha256 }; await ledger.save();
      }
      const bridge = bridgeDir ? await bridgeFactory({ root: bridgeDir, plan, ledger }) : undefined;
      // Auth runs only in explicit live mode, after all target and ledger checks.
      // In OAuth mode, never even read an ambient API-token environment property.
      const apiToken = authMode === 'wrangler-oauth'
        ? await oauthTokenProvider({ home: oauthHome, xdgConfigHome: oauthXdgConfig, timeoutMs: Math.min(10000, remaining()) })
        : env.CLOUDFLARE_API_TOKEN;
      control = createControlPlane({ plan, ledger, fetchImpl, apiToken, bridge: bridge?.request, authMode });
      if (bridge) record(`BRIDGE ${bridge.directory}`);
      record(`LEDGER ${ledger.path}`); await control.preflight();
    }
    if (local) {
      sink = createServer(async (req, res) => { try { let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('body_limit'); } events.push({ event: JSON.parse(body), receivedAt: Date.now(), receivedMonotonic: performance.now() }); res.end('ok'); } catch { res.writeHead(400).end(); } });
      await new Promise(r => sink.listen(0, '127.0.0.1', r));
      fake = await localFakeFactory({ root: join(temp, 'repos'), port: 0, eventUrl: `http://127.0.0.1:${sink.address().port}/events`, advertiseAtomic: false });
      canonical = await fake.binding.create(repoName);
      const repo = await fake.binding.get(repoName); for (const token of (await repo.listTokens()).tokens) await repo.revokeToken(token.id);
    } else {
      canonical = await control.create('repo', repoName, `${control.base}/repos`, { name: repoName, default_branch: 'main' });
      await control.revokeTokens(repoName); record('PASS canonical bootstrap token revoked');
      const queue = await control.create('queue', plan.resources.queue, '/queues', { queue_name: plan.resources.queue }); queueId = queue.queue_id;
      await control.create('consumer', 'http_pull', `/queues/${queueId}/consumers`, { type: 'http_pull', settings: { visibility_timeout_ms: 10000 } }, { parentId: queueId });
      await control.create('subscription', plan.resources.eventSubscription, '/event_subscriptions/subscriptions', { name: plan.resources.eventSubscription, enabled: true,
        source: { type: 'artifacts.repo', namespace, repo_name: repoName }, events: ['pushed'], destination: { type: 'queues.queue', queue_id: queueId } });
    }
    const remote = validateRemote(canonical.remote, { accountId: plan.target.accountId, namespace, name: repoName, local });
    const mint = async (name, scope) => local ? (await (await fake.binding.get(name)).createToken(scope, LIMITS.tokenTtlSeconds)).plaintext : control.mint(name, scope);
    const write = await mint(repoName, 'write'), read = await mint(repoName, 'read');
    const work = join(temp, 'work'); await mkdir(work); await git(['init', '--initial-branch=main'], work); await git(['config', 'user.name', 'Smoke'], work); await git(['config', 'user.email', 'smoke@example.invalid'], work);
    await writeFile(join(work, 'README.md'), 'Artifacts smoke\n'); await git(['add', '.'], work); await git(['commit', '-m', 'Smoke seed'], work);
    // Check name-addressed ownership before each live Git operation; never adopt an existing repo.
    const remoteGit = async (args, token = write, phase) => {
      if (!local) await control.assertOwnedRepo(repoName);
      networkBudget.reserve();
      if (phase === 'main_cas') mainCasStarted = { wall: Date.now(), monotonic: performance.now() };
      return measureGitPhase(phase, () => git(args, work, token, remote, phase), sample => {
        measurements.git.push(sample); record(`TIMING GIT ${JSON.stringify(sample)}`);
      });
    };
    const seed = (await git(['rev-parse', 'HEAD'], work)).trim();
    await remoteGit(['push', remote, `${seed}:refs/heads/main`], write, 'seed_main'); record('PASS main seed push');
    if (local) {
      await (await fake.binding.get(repoName)).fork(forkName, { defaultBranchOnly: true });
      const repo = await fake.binding.get(forkName); for (const token of (await repo.listTokens()).tokens) await repo.revokeToken(token.id);
    } else {
      await control.assertOwnedRepo(repoName);
      await control.create('repo', forkName, `${control.base}/repos/${repoName}/fork`, { name: forkName, default_branch_only: true });
      await control.revokeTokens(forkName); record('PASS fork bootstrap token revoked');
    }
    await mint(forkName, 'write'); record('PASS create/fork/mint token');
    // The transport probe shares production exact-ref checks and expected-old
    // lease argv. It is not the full engine recovery state machine.
    const emptyCommit = async message => {
      await git(['commit', '--allow-empty', '-m', message], work);
      return (await git(['rev-parse', 'HEAD'], work)).trim();
    };
    const candidateX = await emptyCommit('Smoke candidate x'), candidateZ = await emptyCommit('Smoke candidate z');
    const nextMain = await emptyCommit('Smoke publication'), rejectedMain = await emptyCommit('Smoke rejected publication');
    const candidates = { 'refs/heads/candidates/x/y': candidateX, 'refs/heads/candidates/z/y': candidateZ };
    for (const [ref, oid] of Object.entries(candidates)) await git(['update-ref', ref, oid], work);
    await git(['notes', '--ref=heddle-why', 'add', '-m', 'Artifacts why', nextMain], work);
    const notes = (await git(['rev-parse', 'refs/notes/heddle-why'], work)).trim();
    const proofRefs = { ...candidates, 'refs/notes/heddle-why': notes };
    const seedTree = (await git(['rev-parse', `${seed}^{tree}`], work)).trim();
    for (const oid of [candidateX, candidateZ, nextMain, rejectedMain]) {
      if ((await git(['rev-parse', `${oid}^{tree}`], work)).trim() !== seedTree) throw new Error('proof_ref_check_failed');
    }
    await git(['fsck', '--strict'], work);
    const manifest = { format: 1, domain: 'heddle-smoke-transport-v1', main: nextMain, expectedMain: seed,
      inputHash: createHash('sha256').update(JSON.stringify({ seed, main: nextMain, refs: proofRefs })).digest('hex'),
      directoryBefore: null, refs: Object.fromEntries(Object.entries(proofRefs).map(([ref, oid]) => [ref, { oid, before: null }])),
      verify: { syntheticSmoke: true, treeMatch: true, fsck: true } };
    await git(['checkout', '--orphan', 'smoke-directory'], work); await git(['rm', '-f', 'README.md'], work);
    await writeFile(join(work, '.heddle-agents.json'), '[]\n');
    await writeFile(join(work, MANIFEST_PATH), JSON.stringify(manifest) + '\n');
    await git(['add', '.heddle-agents.json', MANIFEST_PATH], work);
    const directoryTree = (await git(['write-tree'], work)).trim();
    // Retain immutable proof objects even after an auxiliary alias advances.
    const directoryOid = (await git(['commit-tree', directoryTree, '-p', nextMain, '-p', notes,
      '-p', candidateX, '-p', candidateZ, '-m', 'Smoke publication manifest'], work)).trim();
    await git(['update-ref', DIRECTORY_REF, directoryOid], work);
    await git(['fsck', '--strict'], work);
    if ((await git(['show', `${directoryOid}:${MANIFEST_PATH}`], work)).trim() !== JSON.stringify(manifest)) throw new Error('proof_ref_check_failed');
    const staged = { ...proofRefs, [DIRECTORY_REF]: directoryOid };
    const objectIds = (await git(['rev-list', '--objects', '--no-object-names', directoryOid], work)).trim().split('\n');
    let objectBytes = 0;
    for (const oid of objectIds) {
      const bytes = Number((await git(['cat-file', '-s', oid], work)).trim());
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('proof_ref_check_failed');
      objectBytes += bytes;
    }
    measurements.fixture = { readme_bytes: Buffer.byteLength(plan.syntheticData.body), agent_directory_bytes: 3,
      manifest_bytes: Buffer.byteLength(JSON.stringify(manifest) + '\n'), reachable_object_count: objectIds.length,
      reachable_uncompressed_object_bytes: objectBytes, main_history_commit_count: 4, fresh_clone_destination: true,
      scope: 'synthetic_published_snapshot', service_cache_state: 'unknown' };
    record(`FIXTURE ${JSON.stringify(measurements.fixture)}`);
    // Ordinary multi-ref staging may expose partial, pending auxiliary refs.
    // A rejected/uncertain stage stops immediately; it never triggers main CAS.
    await remoteGit(['push', remote, ...Object.entries(staged).map(([ref, oid]) => `${oid}:${ref}`)], write, 'stage_proofs');
    record('PASS candidate, notes and manifest staging (auxiliary refs pending)');
    const stagedRefs = await remoteGit(['ls-remote', remote], read, 'staged_refs');
    requireExactRefs(stagedRefs, { ...staged, 'refs/heads/main': seed });
    record('PASS exact staged proof hashes and expected-old main readback');
    await remoteGit(leasedPushArgs(remote, [{ ref: 'refs/heads/main', oid: nextMain, before: seed }]), write, 'main_cas');
    record('PASS main-last expected-old CAS');
    let staleRejected = false;
    try { await remoteGit(leasedPushArgs(remote, [{ ref: 'refs/heads/main', oid: rejectedMain, before: seed }]), write, 'stale_main_cas'); }
    catch (error) { if (error.message !== 'git_stale_info') throw error; staleRejected = true; }
    if (!staleRejected) throw new Error('stale_main_cas_accepted');
    record('PASS stale expected-old main CAS rejected');
    const mirror = join(temp, 'readback.git');
    await remoteGit(['clone', '--mirror', '--no-hardlinks', '--', remote, mirror], read, 'mirror_clone');
    await git(['fsck', '--strict'], mirror);
    const clonedRefs = await git(['show-ref'], mirror);
    requireExactRefs(clonedRefs.replaceAll(' ', '\t'), { ...staged, 'refs/heads/main': nextMain });
    const history = (await git(['rev-list', '--first-parent', 'refs/heads/main'], mirror)).trim().split('\n');
    if (JSON.stringify(history) !== JSON.stringify([nextMain, candidateZ, candidateX, seed])
      || await git(['show', 'refs/heads/main:README.md'], mirror) !== plan.syntheticData.body
      || (await git(['notes', '--ref=heddle-why', 'show', nextMain], mirror)).trim() !== 'Artifacts why'
      || (await git(['show', `${directoryOid}:${MANIFEST_PATH}`], mirror)).trim() !== JSON.stringify(manifest)
      || await git(['show', `${directoryOid}:.heddle-agents.json`], mirror) !== '[]\n') throw new Error('clone_verification_failed');
    for (const oid of [seed, candidateX, candidateZ, nextMain]) {
      if ((await git(['rev-parse', `${oid}^{tree}`], mirror)).trim() !== seedTree) throw new Error('clone_verification_failed');
    }
    record('PASS fresh mirror clone, strict fsck, exact synthetic history, trees, note and manifest contents');
    const refs = await remoteGit(['ls-remote', remote], read, 'final_refs');
    const expectedFinal = { ...staged, 'refs/heads/main': nextMain, ...(missingRef ? { 'refs/heads/missing': seed } : {}) };
    requireExactRefs(refs, expectedFinal);
    networkBudget.requireComplete();
    if (ledger) { ledger.state.publication = { protocol: plan.publication.protocol, manifest, directoryOid, expectedFinal }; await ledger.save(); }
    record('PASS final exact main, candidate, notes and manifest hashes; stale CAS changed no refs');
    const deadline = Math.min(Date.now() + LIMITS.eventSeconds * 1000, normalDeadline); let pulls = 0;
    while (Date.now() < deadline && queueTiming === undefined && pulls < LIMITS.maxQueuePulls) {
      if (!local) {
        pulls++;
        const messages = await control.api(`/queues/${queueId}/messages/pull`, 'POST', { batch_size: LIMITS.queueBatchSize, visibility_timeout_ms: 10000 });
        const acks = [];
        for (const message of messages.messages ?? []) {
          let event = message.body;
          if (typeof event === 'string') { try { event = JSON.parse(event); } catch { event = JSON.parse(Buffer.from(event, 'base64').toString()); } }
          events.push({ event, receivedAt: Date.now(), receivedMonotonic: performance.now() }); acks.push({ lease_id: message.lease_id });
        }
        if (acks.length) await control.api(`/queues/${queueId}/messages/ack`, 'POST', { acks, retries: [] });
      }
      queueTiming = events.map(item => publicationEventTiming(item, { namespace, repoName, before: seed, after: nextMain,
        sentAt: mainCasStarted.wall, sentMonotonic: mainCasStarted.monotonic })).find(Boolean);
      if (!queueTiming) await new Promise(r => setTimeout(r, 2000));
    }
    if (!queueTiming) { measurements.queue = { outcome: 'failure', failure: 'event_timeout' }; record('FAIL pushed event deadline; R3: alarm polling remains enabled'); throw new Error('event_timeout'); }
    measurements.queue = queueTiming;
    record(`PASS ${local ? 'fake hook' : 'Queue'} exact main-CAS pushed event; observation delay ${queueTiming.observation_delay_ms} ms`);
    record(`TIMING QUEUE ${JSON.stringify(queueTiming)}`); exitCode = 0;
  } catch (error) { failure = safeFailure(error); record(`SMOKE FAIL: ${failure} (credentials suppressed)`); }
  finally {
    record(`GIT NETWORK COMMANDS ${networkBudget.used}/${networkBudget.max}`);
    try { if (control && !await control.cleanupResources(record)) exitCode = 1; }
    catch { record('CLEANUP FAIL: ledger_or_cleanup_error; manual reconciliation required'); exitCode = 1; }
    try { if (fake) await fake.close(); if (sink) { sink.closeAllConnections(); await new Promise(r => sink.close(r)); } if (temp) await rm(temp, { recursive: true, force: true }); }
    catch { record('CLEANUP FAIL: local_temp_cleanup'); exitCode = 1; }
    measurements.run = { elapsed_ms: Math.max(0, Math.round((performance.now() - startedMonotonic) * 1000) / 1000),
      outcome: exitCode === 0 ? 'success' : 'failure', includes_cleanup: true,
      fresh_process: import.meta.url === pathToFileURL(process.argv[1] ?? '').href,
      service_cache_state: 'unknown', sample_count: 1 };
    if (ledger) {
      ledger.state.status = exitCode === 0 ? 'passed_and_cleaned' : 'failed_or_cleanup_incomplete'; ledger.state.failure = failure ?? null;
      ledger.state.gitNetworkCommands = networkBudget.used; ledger.state.outcomes = outcomes; ledger.state.finishedAt = new Date().toISOString();
      try { await ledger.save(); } catch { record('CLEANUP FAIL: final_ledger_write'); exitCode = 1; measurements.run.outcome = 'failure'; }
    }
    record(`TIMING RUN ${JSON.stringify(measurements.run)}`);
  }
  if (exitCode === 0) record(local ? 'LOCAL-SMOKE PASS (not A-S1 real-account evidence)' : 'A-S1 PASS (checks and cleanup confirmed; retained ledger)');
  return exitCode;
}
export async function main(argv = process.argv.slice(2), { log = console.log, env = process.env, fetchImpl = fetch, oauthTokenProvider = getPrivateOAuthToken, bridgeFactory = createFileControlBridge, gitTransportLoader = loadGitTransportConfig } = {}) {
  try {
    const flags = new Set(['--plan', '--fake', '--live', '--prove-ref-check']);
    const values = new Map([['--run-id', 'runId'], ['--namespace', 'namespace'], ['--account-id', 'accountId'], ['--account-name', 'accountName'], ['--account-plan', 'accountPlan'], ['--jurisdiction', 'jurisdiction'], ['--plan-file', 'planFile'], ['--ledger-dir', 'ledgerDir'], ['--auth-mode', 'authMode'], ['--oauth-home', 'oauthHome'], ['--oauth-xdg-config', 'oauthXdgConfig'], ['--bridge-dir', 'bridgeDir'], ['--git-transport-config', 'gitTransportConfig']]);
    const options = {}, seen = new Set();
    for (let i = 0; i < argv.length; i++) { const key = argv[i]; if (seen.has(key)) throw new Error('duplicate_argument'); seen.add(key);
      if (flags.has(key)) options[key.slice(2)] = true;
      else if (values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[values.get(key)] = argv[++i];
      else throw new Error('invalid_argument');
    }
    if ([options.plan, options.fake, options.live].filter(Boolean).length !== 1) throw new Error('choose_plan_fake_or_live');
    if (options.plan) { if (['planFile', 'ledgerDir', 'authMode', 'oauthHome', 'oauthXdgConfig', 'bridgeDir', 'gitTransportConfig', 'prove-ref-check'].some(key => options[key])) throw new Error('invalid_argument'); log(JSON.stringify(makePlan(options), null, 2)); return 0; }
    if (options.fake) { if ([...values.values()].some(key => options[key])) throw new Error('invalid_argument'); return smoke({ local: true, missingRef: !!options['prove-ref-check'], log }); }
    if (!options.planFile || !options.runId || !options.ledgerDir || options['prove-ref-check']) throw new Error('planned_run_id_required');
    if (['namespace', 'accountId', 'accountName', 'accountPlan', 'jurisdiction'].some(key => options[key])) throw new Error('invalid_argument');
    const plan = JSON.parse(await readFile(options.planFile, 'utf8'));
    return smoke({ plan, runId: options.runId, ledgerDir: options.ledgerDir, authMode: options.authMode,
      oauthHome: options.oauthHome, oauthXdgConfig: options.oauthXdgConfig, bridgeDir: options.bridgeDir,
      gitTransportConfig: options.gitTransportConfig, gitTransportLoader, env, fetchImpl, oauthTokenProvider, bridgeFactory, log });
  } catch (error) { log(`A-S1 BLOCKED: ${safeFailure(error)}. Live mode requires a reviewed, unexpired plan, exact run ID and persistent ledger directory.`); return 2; }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
