// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, git, gitAuth, remote, slug, Rejection } from './process.mjs';
import { stateRoot, repoRoot, exportRoot, identity, heddle } from './state.mjs';
import { forkRemote, fetchCommits, materialize, conflictPaths, diffstat, fixedIdentity } from './git.mjs';
import { verifyCapture } from './signatures.mjs';
import { testCandidate } from './tests.mjs';
import { narrative } from './why.mjs';
import { exportProjection } from './projection.mjs';
import { attestOperation, attestTests } from './attestations.mjs';
import { isolatedTestResult } from './isolated-tests.mjs';
import { freezePublicationInput } from './publication-input.mjs';

/** @typedef {import('../../contracts/types.ts').Candidate} Candidate */
/** @typedef {import('../../contracts/types.ts').Turn} Turn */
/** @typedef {import('../../contracts/types.ts').Decision} Decision */

export function taskFor(state, id) {
  slug(id);
  const task = state.tasks[id];
  if (!task) throw new Rejection('unknown_task', 'Task is not registered');
  return task;
}
export function agentFor(state, id) {
  slug(id);
  const agent = state.agents[id];
  if (!agent) throw new Rejection('unknown_agent', 'Agent is not enrolled');
  return agent;
}
export function candidates(state, id) {
  taskFor(state, id);
  const list = Object.values(state.lanes).filter(l => l.task === id && l.candidate).map(l => l.candidate).sort((a, b) => a.agent.localeCompare(b.agent));
  return { heads: list.map(c => c.state).sort(), candidates: list };
}
export async function init(state, request) {
  if (state.project) throw new Rejection('already_initialized', 'Project is already initialized');
  slug(request.project); remote(request.canonical?.remote);
  if (!request.seed?.importUrl && request.seed?.template !== 'demo') throw new Rejection('invalid_seed', 'Specify template demo or importUrl');
  if (request.seed?.importUrl) remote(request.seed.importUrl);
  await identity('_engine');
  await mkdir(repoRoot, { recursive: true });
  await heddle(['init', '--no-harness-install']);
  const seed = join(stateRoot, 'seed.git');
  if (request.seed?.importUrl) {
    const source = remote(request.seed.importUrl);
    await git(stateRoot, ['clone', '--bare', '--', source, seed], { env: gitAuth(source) });
  } else if (request.seed?.template === 'demo') {
    const source = process.env.ENGINE_DEMO_SEED || fileURLToPath(new URL('../../demo/seed-project/', import.meta.url));
    const work = join(stateRoot, 'seed-work');
    await cp(source, work, { recursive: true, filter: path => !['node_modules', '.git'].includes(path.split('/').at(-1)) });
    await git(work, ['init', '-b', 'main']);
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'Demo seed'], { env: fixedIdentity() });
    await git(stateRoot, ['clone', '--bare', work, seed]);
    await rm(work, { recursive: true, force: true });
  } else throw new Rejection('invalid_seed', 'Specify template demo or importUrl');
  await heddle(['bridge', 'git', 'import', '--path', seed, '--ref', 'main']);
  await heddle(['thread', 'switch', 'main']);
  await heddle(['bridge', 'git', 'export', '--destination', exportRoot]);
  const mainSha = await git(exportRoot, ['rev-parse', 'main']);
  await materialize(mainSha, repoRoot);
  const main = await heddle(['show', 'main']);
  state.project = request.project; state.canonical = request.canonical.remote;
  state.mainSha = mainSha; state.mainState = main.state_id_full;
  await git(exportRoot, ['push', state.canonical, 'refs/heads/main:refs/heads/main'], { env: gitAuth(state.canonical, true) });
  await rm(seed, { recursive: true, force: true });
  return { mainState: state.mainState, mainSha };
}
export async function createTask(state, request) {
  slug(request.task);
  if (state.tasks[request.task]) throw new Rejection('task_exists', 'Task already exists');
  if (typeof request.intent !== 'string' || !request.intent.trim()) throw new Rejection('invalid_intent', 'Task intent is required');
  const thread = `task/${request.task}`;
  const path = join(stateRoot, 'lanes', request.task, '_task');
  const base = await heddle(['show', 'main']);
  await heddle(['start', thread, '--from', base.state_id_full, '--path', path, '--workspace', 'solid', '--no-daemon', '--task', request.intent]);
  state.tasks[request.task] = { thread, path, intent: request.intent, baseState: base.state_id_full, baseSha: state.mainSha };
  return { thread, baseState: base.state_id_full, baseSha: state.mainSha };
}
export async function enroll(state, request) {
  const agent = request.agent;
  slug(agent?.id);
  if (!['agent', 'human', 'reviewer'].includes(agent.kind) || typeof agent.displayName !== 'string') throw new Rejection('invalid_agent', 'Agent kind and displayName are required');
  if (!state.agents[agent.id]) state.agents[agent.id] = { id: agent.id, kind: agent.kind, displayName: agent.displayName, ...(agent.provider ? { provider: agent.provider } : {}), ...(agent.model ? { model: agent.model } : {}), publicKey: await identity(agent.id) };
  return { publicKey: state.agents[agent.id].publicKey };
}
export async function openLane(state, request) {
  const task = taskFor(state, request.task), agent = agentFor(state, request.agent);
  const key = `${request.task}/${request.agent}`;
  if (state.lanes[key]) return { laneThread: state.lanes[key].thread, leaseId: state.lanes[key].leaseId };
  const thread = `task/${key}`, path = join(stateRoot, 'lanes', request.task, request.agent);
  await heddle(['start', thread, '--from', task.baseState, '--path', path, '--workspace', 'solid', '--no-daemon', '--parent-thread', task.thread, '--task', task.intent], task.path, agent);
  const grant = await heddle(['agent', 'reserve', '--thread', thread, '--anchor', task.baseState], path, agent);
  const leaseId = grant.reservation.lease_id;
  await writeFile(join(path, '.heddle', 'engine-lease.json'), JSON.stringify({ leaseId, token: grant.token, expiresAt: grant.reservation.lease_expires_at }), { mode: 0o600 });
  state.lanes[key] = { task: request.task, agent: request.agent, thread, path, leaseId, remote: forkRemote(state.canonical, state.project, request.task, request.agent), status: 'active', seen: {} };
  return { laneThread: thread, leaseId };
}

async function authenticatedLease(state, lane) {
  const file = join(lane.path, '.heddle', 'engine-lease.json'), agent = state.agents[lane.agent];
  let lease = JSON.parse(await readFile(file));
  if (lease.expiresAt && Date.parse(lease.expiresAt) <= Date.now()) {
    // The engine remains the trusted lane owner; stock reserve reaps expiration.
    const grant = await heddle(['agent', 'reserve', '--thread', lane.thread], lane.path, agent);
    lane.leaseId = grant.reservation.lease_id;
    lease = { leaseId: lane.leaseId, token: grant.token, expiresAt: grant.reservation.lease_expires_at };
  }
  const heartbeat = await heddle(['agent', 'heartbeat', '--lease', lane.leaseId], lane.path, agent, { env: { HEDDLE_RESERVATION_TOKEN: lease.token }, raw: true, allowFailure: true });
  if (heartbeat.code !== 0) throw new Rejection('lease_invalid', 'Writer lease did not authorize capture');
  lease.expiresAt = JSON.parse(heartbeat.stdout).reservation.lease_expires_at;
  await writeFile(file, JSON.stringify(lease), { mode: 0o600 });
  return lease;
}

export async function ingest(state, request) {
  if (!Array.isArray(request.items)) throw new Rejection('invalid_items', 'items must be an array');
  const results = [], pending = [];
  for (const item of request.items) {
    if (!item || typeof item !== 'object' || typeof item.sha !== 'string' || !/^[0-9a-f]{40}$/.test(item.sha)) throw new Rejection('invalid_sha', 'Every push requires a complete SHA-1 commit id');
    const lane = state.lanes[`${item.task}/${item.agent}`];
    if (!lane || item.fork?.remote !== lane.remote || item.ref !== 'refs/heads/main') results.push({ agent: item.agent, task: item.task, status: 'rejected', reason: 'lane_mismatch' });
    else if (lane.seen[item.sha]) results.push({ agent: item.agent, task: item.task, status: 'duplicate', candidate: lane.seen[item.sha] });
    else if (lane.status !== 'active') results.push({ agent: item.agent, task: item.task, status: 'rejected', reason: 'lane_released' });
    else pending.push({ item, lane });
  }
  const leases = new Map();
  for (const { lane } of pending) if (!leases.has(lane)) leases.set(lane, await authenticatedLease(state, lane));
  // Fetch independent forks concurrently. No shared ref or FETCH_HEAD writes.
  const groups = new Map();
  for (const { item } of pending) {
    if (!groups.has(item.fork.remote)) groups.set(item.fork.remote, []);
    groups.get(item.fork.remote).push(item.sha);
  }
  const fetches = await Promise.allSettled([...groups].map(([source, shas]) => fetchCommits(source, shas)));
  for (const fetched of fetches) if (fetched.status === 'rejected') throw fetched.reason;
  for (let i = 0; i < pending.length; i++) {
    const { item, lane } = pending[i], agent = state.agents[item.agent];
    if (lane.seen[item.sha]) {
      results.push({ agent: item.agent, task: item.task, status: 'duplicate', candidate: lane.seen[item.sha] });
      continue;
    }
    await materialize(item.sha, lane.path);
    const lease = leases.get(lane);
    const subject = await git(exportRoot, ['show', '-s', '--format=%s', item.sha]);
    const env = { HEDDLE_RESERVATION_TOKEN: lease.token };
    if (agent.provider && agent.model) await heddle(['agent', 'provenance', 'begin', '--provider', agent.provider, '--model', agent.model], lane.path, agent);
    await heddle(['agent', 'capture', '--lease', lane.leaseId, '-m', subject], lane.path, agent, { env });
    const shown = await heddle(['show'], lane.path, agent);
    const signedBy = await verifyCapture(join(repoRoot, '.heddle'), shown, agent.publicKey);
    if (agent.provider && agent.model) await heddle(['agent', 'provenance', 'end'], lane.path, agent);
    /** @type {Candidate} */
    const candidate = { task: item.task, agent: item.agent, state: shown.state_id_full, sourceSha: item.sha,
      treeSha: await git(exportRoot, ['rev-parse', `${item.sha}^{tree}`]), parentSha: state.tasks[item.task].baseSha,
      subject, diffstat: await diffstat(state.tasks[item.task].baseSha, item.sha),
      tests: request.runTests ? await testCandidate(lane.path) : { status: 'skipped', passed: 0, failed: 0, summary: 'Tests not requested', durationMs: 0 },
      conflicts: [], signedBy, capturedAt: shown.created_at };
    if (request.runTests && request.isolateUnreviewed && candidate.tests.status === 'skipped') {
      candidate.tests = { status: 'pending', passed: 0, failed: 0, summary: 'Isolated sandbox tests pending', durationMs: 0, provenance: 'isolated sandbox', sourceSha: item.sha };
    } else if (candidate.tests.status !== 'skipped') candidate.tests.provenance = 'reviewed fixture';
    lane.candidate = candidate; lane.seen[item.sha] = candidate;
    await git(exportRoot, ['update-ref', `refs/heads/candidates/${item.task}/${item.agent}`, item.sha]);
    results.push({ agent: item.agent, task: item.task, status: 'captured', candidate });
  }
  const conflicts = {};
  for (const id of new Set(request.items.map(item => item.task))) {
    if (!state.tasks[id]) continue;
    const list = candidates(state, id).candidates;
    for (const candidate of list) candidate.conflicts = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      for (const path of await conflictPaths(state.tasks[id].baseSha, list[i].sourceSha, list[j].sourceSha)) {
        for (const [candidate, other] of [[list[i], list[j]], [list[j], list[i]]]) {
          let conflict = candidate.conflicts.find(c => c.path === path);
          if (!conflict) candidate.conflicts.push(conflict = { path, with: [] });
          conflict.with.push(other.agent); conflict.with.sort();
        }
      }
    }
    conflicts[id] = list.flatMap(c => c.conflicts);
  }
  const refs = [...new Set(pending.map(({ item }) => `refs/heads/candidates/${item.task}/${item.agent}`))];
  if (refs.length) await git(exportRoot, ['push', state.canonical, ...refs.map(ref => `${ref}:${ref}`)], { env: gitAuth(state.canonical, true) });
  return { results, conflicts };
}

export async function recordTests(state, request) {
  const lane = state.lanes[`${request.task}/${request.agent}`], candidate = lane?.candidate;
  // A late result is consumed but never applied to a newer Capture or a decision.
  if (!candidate || candidate.sourceSha !== request.sourceSha || state.decisions[request.task] || lane.status !== 'active') return { ignored: true };
  if (candidate.tests?.status !== 'pending' || candidate.tests.provenance !== 'isolated sandbox') return { ignored: true };
  const run = request.run;
  if (run?.sourceSha !== request.sourceSha || run?.treeSha !== candidate.treeSha) throw new Rejection('test_binding_mismatch', 'Test observation must match the captured SHA and tree');
  const tests = isolatedTestResult(run);
  const observation = await attestTests({ project: state.project, task: request.task, agent: request.agent,
    sourceSha: candidate.sourceSha, treeSha: candidate.treeSha, state: candidate.state, tests, observedAt: new Date().toISOString() });
  candidate.tests = { ...tests, observation };
  lane.seen[candidate.sourceSha] = candidate;
  state.narratives[candidate.sourceSha] = narrative(state, request.task);
  return { ignored: false, candidate };
}

export async function diff(state, request) {
  const task = taskFor(state, request.task), lane = state.lanes[`${request.task}/${request.agent}`];
  if (!lane?.candidate) throw new Rejection('unknown_candidate', 'Candidate is unavailable');
  const maxBytes = Math.min(512 * 1024, Math.max(0, request.maxBytes === undefined ? 512 * 1024 : Number(request.maxBytes)));
  const output = (await run('git', ['--git-dir', exportRoot, 'diff', '--no-ext-diff', task.baseSha, lane.candidate.sourceSha, '--'])).stdout;
  return { diff: output.subarray(0, maxBytes).toString() };
}

export async function discuss(state, request) {
  const task = taskFor(state, request.task), author = agentFor(state, request.author);
  if (typeof request.body !== 'string' || !request.body.trim()) throw new Rejection('invalid_body', 'Discussion body is required');
  const parent = request.replyTo ? state.turns.find(turn => turn.id === request.replyTo && turn.task === request.task) : undefined;
  if (request.replyTo && !parent) throw new Rejection('unknown_turn', 'Reply target does not belong to this task');
  let result;
  if (parent) {
    const turnNumber = state.turns.filter(t => t.heddleDiscussion === parent.heddleDiscussion).findIndex(t => t.id === parent.id) + 1;
    result = await heddle(['discuss', 'reply', parent.heddleDiscussion, '--turn', String(turnNumber), '--body', request.body], task.path, author);
  }
  else {
    const conflictPath = candidates(state, request.task).candidates.flatMap(c => c.conflicts)[0]?.path;
    const basePaths = (await run('git', ['--git-dir', exportRoot, 'ls-tree', '-rz', '--name-only', task.baseSha])).stdout.toString().split('\0').filter(Boolean);
    const path = conflictPath && basePaths.includes(conflictPath) ? conflictPath : basePaths[0];
    if (!path) throw new Rejection('missing_anchor', 'Discussion needs a file in the task base');
    result = await heddle(['discuss', 'new', '--path', path, '--thread', task.thread, '--title', `${request.task}: ${author.displayName}`, '--body', request.body], task.path, author);
  }
  /** @type {Turn} */
  const turn = { id: result.turn_id || result.operation_id || result.discussion_id, task: request.task, author: request.author, kind: author.kind, body: request.body,
    ...(request.replyTo ? { replyTo: request.replyTo } : {}), heddleDiscussion: result.discussion?.id || parent?.heddleDiscussion,
    signedBy: await attestOperation(state, author, result.operation_id, { task: request.task, body: request.body, ...(request.replyTo ? { replyTo: request.replyTo } : {}) }),
    at: new Date(result.discussion.turns.find(t => t.operation_id === result.operation_id).occurred_at_ms).toISOString() };
  state.turns.push(turn);
  return turn;
}

export async function decide(state, request) {
  const task = taskFor(state, request.task), decider = agentFor(state, request.decider);
  const current = candidates(state, request.task);
  if (!Array.isArray(request.expectHeads) || JSON.stringify([...request.expectHeads].sort()) !== JSON.stringify(current.heads)) throw new Rejection('stale', 'Candidates changed; review the current heads');
  if (current.candidates.some(c => c.tests?.status === 'pending')) throw new Rejection('tests_pending', 'Wait for isolated candidate tests before deciding');
  if (state.decisions[request.task]) throw new Rejection('already_decided', 'Task already has a decision');
  const lane = state.lanes[`${request.task}/${request.pick}`];
  if (!lane?.candidate) throw new Rejection('unknown_candidate', 'Chosen candidate is unavailable');
  if (typeof request.rationale !== 'string' || !request.rationale.trim()) throw new Rejection('invalid_rationale', 'Decision rationale is required');
  if (task.baseSha !== state.mainSha) {
    const containsMain = await run('git', ['--git-dir', exportRoot, 'merge-base', '--is-ancestor', state.mainSha, lane.candidate.sourceSha], { allowFailure: true });
    if (containsMain.code !== 0) throw new Rejection('base_changed', 'Main advanced; merge upstream main into the chosen fork and push again');
  }
  const alternatives = current.candidates.map(c => c.agent).filter(id => id !== request.pick);
  // G2 fallback b2: absorb only the selected native lane; other alternatives remain addressable.
  const message = `${request.rationale}\n\nHeddle-Task: ${request.task}\nHeddle-Chosen: ${request.pick}\n${alternatives.map(id => `Heddle-Alternative: ${id}`).join('\n')}\nHeddle-Decided-by: ${request.decider}`;
  await heddle(['thread', 'absorb', lane.thread, '--into', task.thread, '-m', message], task.path, decider);
  const decisionTurn = await discuss(state, { task: request.task, author: request.decider, body: request.rationale });
  const resolutionRecord = await heddle(['discuss', 'resolve', decisionTurn.heddleDiscussion, '--mode', 'into-annotation', '--kind', 'rationale', '--body', request.rationale], task.path, decider);
  // b2 can fast-forward: the selected State keeps its original agent signature.
  // The human's custodial attestation signs the exact native resolution envelope.
  const resolution = await heddle(['show', task.thread], task.path, decider);
  await verifyCapture(join(repoRoot, '.heddle'), resolution, state.agents[request.pick].publicKey);
  await heddle(['land', '--thread', task.thread, '-m', message], task.path, decider);
  const landed = await heddle(['show', 'main'], repoRoot, decider);
  const native = await exportProjection({ ...state, projection: undefined });
  if (native.tree !== lane.candidate.treeSha) throw new Rejection('tree_mismatch', 'Heddle landed content differs from the selected work');
  const change = /Heddle-Change: (\S+)/.exec(native.message)?.[1];
  if (!change) throw new Error('Native projection omitted change trailer');
  // A b2 fast-forward retains the candidate Capture's creation time. The
  // decision belongs to this native rationale turn, not that earlier Capture.
  // Persist the same native timestamp in both the decision and projection pin.
  state.projection = { parentSha: state.mainSha, treeSha: native.tree, author: decider.displayName,
    email: `${decider.id}@heddle-artifacts.local`, at: decisionTurn.at,
    message: `${message}\n\nHeddle-State: ${landed.state_id_full}\nHeddle-Change: ${change}` };
  const mainSha = (await exportProjection(state)).sha;
  /** @type {Decision} */
  const decision = { task: request.task, decider: request.decider, pick: request.pick, rationale: request.rationale, alternatives,
    resolutionState: resolution.state_id_full, landState: landed.state_id_full, mainSha, at: decisionTurn.at };
  await attestOperation(state, decider, resolutionRecord.operation_id, { decision });
  state.decisionAttestations ||= {};
  state.decisionAttestations[request.task] = resolutionRecord.operation_id;
  state.decisions[request.task] = decision;
  state.mainSha = mainSha; state.mainState = decision.landState;
  for (const alternative of current.candidates) {
    const closing = state.lanes[`${request.task}/${alternative.agent}`];
    const lease = JSON.parse(await readFile(join(closing.path, '.heddle', 'engine-lease.json')));
    await heddle(['agent', 'release', '--lease', closing.leaseId, '--status', alternative.agent === request.pick ? 'complete' : 'abandoned'], closing.path, state.agents[alternative.agent], { env: { HEDDLE_RESERVATION_TOKEN: lease.token } });
    closing.status = alternative.agent === request.pick ? 'released' : 'abandoned';
  }
  state.narratives[mainSha] = narrative(state, request.task, decision);
  await freezePublicationInput(state);
  return decision;
}
