// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, git, gitAuth, remote, slug, Rejection } from './process.mjs';
import { decisionOptions, DecisionInputError } from './decision-anchor.mjs';
import { stateRoot, repoRoot, exportRoot, identity, heddle, actorEmail } from './state.mjs';
import { forkRemote, fetchCommits, materialize, conflictPaths, diffstat, fixedIdentity } from './git.mjs';
import { verifyCapture } from './signatures.mjs';
import { testCandidate } from './tests.mjs';
import { narrative } from './why.mjs';
import { exportProjection } from './projection.mjs';
import { attestOperation, attestTests } from './attestations.mjs';
import { isolatedTestResult } from './isolated-tests.mjs';
import { freezePublicationInput } from './publication-input.mjs';
import { refreshCombined, combinedRejection, containsMain, integrateMain, descendsFrom, nativeTrees } from './combined.mjs';

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
  let imported;
  if (request.seed?.importUrl && request.seed.snapshot === true) {
    // Heddle 0.30's `bridge git export` rewalks all history on every export (over a minute for a
    // few hundred commits), so a real repository is seeded as one commit with its tip's exact tree.
    // Heddle refuses shallow repositories, so the tip's objects move into a fresh, complete one.
    const source = remote(request.seed.importUrl), shallow = join(stateRoot, 'seed-shallow.git');
    await git(stateRoot, ['clone', '--bare', '--depth', '1', '--no-tags', '--', source, shallow], { env: gitAuth(source) });
    const sha = await git(shallow, ['rev-parse', 'HEAD^{commit}']), tree = await git(shallow, ['rev-parse', 'HEAD^{tree}']);
    const message = `Import ${source} at ${sha}\n\nThis commit holds the source's tree at ${sha} exactly; its history stays at the source.\n`;
    const commit = await git(shallow, ['commit-tree', tree], { input: message, env: fixedIdentity() });
    const objects = await run('git', ['--git-dir', shallow, 'rev-list', '--objects', commit], { maxBytes: 64 * 1024 * 1024 });
    const pack = await run('git', ['--git-dir', shallow, 'pack-objects', '--stdout', '-q'], { input: objects.stdout, maxBytes: 512 * 1024 * 1024 });
    await git(stateRoot, ['init', '--quiet', '--bare', seed]);
    await run('git', ['--git-dir', seed, 'index-pack', '--stdin', '--fix-thin'], { input: pack.stdout });
    await git(seed, ['update-ref', 'refs/heads/main', commit]);
    await git(seed, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    if (await git(seed, ['rev-parse', 'main^{tree}']) !== tree) throw new Rejection('import_tree_mismatch', 'The imported tree differs from the source');
    await rm(shallow, { recursive: true, force: true });
    imported = { url: source, sha, tree };
  } else if (request.seed?.importUrl) {
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
  if (imported) state.imported = imported;
  return { mainState: state.mainState, mainSha, ...(imported ? { imported } : {}) };
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
  if (agent.sponsor !== undefined && typeof agent.sponsor !== 'boolean') throw new Rejection('invalid_sponsor', 'sponsor must be a boolean');
  const sponsor = Object.values(state.agents).find(a => a.sponsor === true);
  if (agent.sponsor === true) {
    if (agent.kind !== 'human' || typeof agent.email !== 'string' || !agent.email) throw new Rejection('invalid_sponsor', 'A sponsor must be a human with an email');
    if (sponsor && sponsor.id !== agent.id) throw new Rejection('sponsor_exists', 'The project already has a sponsor');
  }
  const prior = state.agents[agent.id];
  if (prior && (prior.kind !== agent.kind || agent.kind === 'human' && prior.email !== agent.email)) throw new Rejection('identity_exists', 'Identity already exists with different attributes');
  if (!prior) {
    const record = { id: agent.id, kind: agent.kind, displayName: agent.displayName, ...(agent.email !== undefined ? { email: agent.email } : {}), ...(agent.sponsor === true ? { sponsor: true } : {}), ...(agent.provider ? { provider: agent.provider } : {}), ...(agent.model ? { model: agent.model } : {}) };
    record.address = actorEmail(record, { sponsor });
    state.agents[agent.id] = { ...record, publicKey: await identity(agent.id) };
  } else if (agent.sponsor === true) prior.sponsor = true;
  const { publicKey, address } = state.agents[agent.id];
  return { publicKey, ...(address !== undefined ? { address } : {}) };
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
  // Brief the new lane before its agent starts: Heddle's bounded pre-turn briefing carries earlier
  // decisions' annotations (for example a decider's rationale) and records a signed briefing for the
  // lane. Reviewers judge candidates; they are not briefed as authors. `brief: false` opens a control lane.
  const briefing = agent.kind === 'agent' && request.brief !== false ? laneBriefing(await heddle(['context', '--for-thread', thread], path, agent)) : undefined;
  // Heddle records no thread start time, so the engine keeps when this lane opened for the Captures view.
  state.lanes[key] = { task: request.task, agent: request.agent, thread, path, leaseId, remote: forkRemote(state.canonical, state.project, request.task, request.agent), status: 'active', seen: {}, openedAt: new Date().toISOString(), ...(briefing ? { briefing } : {}) };
  return { laneThread: thread, leaseId, ...(briefing ? { briefing } : {}) };
}
/** Keep only what the control plane shows and the agent reads: the latest revision of each annotation. */
export function laneBriefing(output) {
  if (!output || typeof output.briefing_hash !== 'string' || !Array.isArray(output.annotations)) throw new Rejection('briefing_unavailable', 'Heddle returned no lane briefing');
  return {
    hash: output.briefing_hash,
    omitted: Number(output.omitted_annotations) || 0,
    annotations: output.annotations.slice(0, 20).flatMap(a => {
      const latest = Array.isArray(a.revisions) ? a.revisions[a.revisions.length - 1] : undefined;
      if (!latest || typeof latest.content !== 'string') return [];
      return [{ target: String(a.target), scope: String(a.scope ?? ''), annotationId: String(a.annotation_id), revisionId: String(latest.revision_id),
        tags: Array.isArray(latest.tags) ? latest.tags.filter(t => typeof t === 'string') : [],
        kind: String(latest.kind), content: latest.content.slice(0, 2000), attribution: String(latest.attribution ?? '') }];
    }),
  };
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
      subject, diffstat: await diffstat(await diffBase(state, state.tasks[item.task], item.sha), item.sha),
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
  // A capture on a task whose base is behind main is checked combined with main before it can land.
  if (pending.length) for (const id of new Set(pending.map(({ item }) => item.task))) refs.push(...await refreshCombined(state, id, { isolate: !!(request.runTests && request.isolateUnreviewed) }));
  if (refs.length) await git(exportRoot, ['push', state.canonical, ...refs.map(ref => `${ref}:${ref}`)], { env: gitAuth(state.canonical, true) });
  return { results, conflicts };
}

export async function recordTests(state, request) {
  if (request.combined !== undefined) return recordCombinedTests(state, request);
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

/** The isolated sandbox's run of a candidate merged with main: a separate signed observation of the combined commit. */
async function recordCombinedTests(state, request) {
  const lane = state.lanes[`${request.task}/${request.agent}`], candidate = lane?.candidate, combined = candidate?.combined;
  if (!request.combined || typeof request.combined.sha !== 'string' || typeof request.combined.mainSha !== 'string') throw new Rejection('invalid_combined', 'Combined test results name the combined commit and main');
  // A late result for an older main, an older push or a decided task is consumed, never applied.
  if (!combined || candidate.sourceSha !== request.sourceSha || combined.sha !== request.combined.sha || combined.mainSha !== request.combined.mainSha ||
      combined.mainSha !== state.mainSha || state.decisions[request.task] || lane.status !== 'active' || combined.tests?.status !== 'pending') return { ignored: true };
  const run = request.run;
  if (run?.sourceSha !== combined.sha || run?.treeSha !== combined.treeSha) throw new Rejection('test_binding_mismatch', 'Test observation must match the combined SHA and tree');
  const tests = isolatedTestResult(run);
  const observation = await attestTests({ project: state.project, task: request.task, agent: request.agent, check: 'combined-with-main',
    sourceSha: combined.sha, treeSha: combined.treeSha, state: combined.state, candidateSha: candidate.sourceSha, candidateState: candidate.state,
    mainSha: combined.mainSha, tests, observedAt: new Date().toISOString() });
  combined.tests = { ...tests, observation };
  combined.status = tests.status;
  lane.seen[candidate.sourceSha] = candidate;
  return { ignored: false, candidate };
}

/** Re-check a task's candidates against the current main (after another task lands). Idempotent per main. */
export async function combine(state, request) {
  taskFor(state, request.task);
  const refs = await refreshCombined(state, request.task, { isolate: request.isolate === true });
  if (refs.length) await git(exportRoot, ['push', state.canonical, ...refs.map(ref => `${ref}:${ref}`)], { env: gitAuth(state.canonical, true) });
  return { task: request.task, candidates: candidates(state, request.task).candidates };
}

/** Diff a candidate against what it changes: main when it has merged main, otherwise the task base. */
async function diffBase(state, task, sha) {
  return task.baseSha !== state.mainSha && await containsMain(state, sha) ? state.mainSha : task.baseSha;
}

export async function diff(state, request) {
  const task = taskFor(state, request.task), lane = state.lanes[`${request.task}/${request.agent}`];
  if (!lane?.candidate) throw new Rejection('unknown_candidate', 'Candidate is unavailable');
  const maxBytes = Math.min(512 * 1024, Math.max(0, request.maxBytes === undefined ? 512 * 1024 : Number(request.maxBytes)));
  const output = (await run('git', ['--git-dir', exportRoot, 'diff', '--no-ext-diff', await diffBase(state, task, lane.candidate.sourceSha), lane.candidate.sourceSha, '--'])).stdout;
  return { diff: output.subarray(0, maxBytes).toString() };
}

function parsedDecisionAnchor(request) {
  try { return decisionOptions(request); }
  catch (error) { if (error instanceof DecisionInputError) throw new Rejection(error.code, error.message); throw error; }
}
async function treeFiles(tree) {
  const output = await run('git', ['--git-dir', exportRoot, 'ls-tree', '-rz', tree]);
  return output.stdout.toString().split('\0').filter(row => /^\d+ blob /.test(row)).map(row => row.slice(row.indexOf('\t') + 1));
}
export async function validateDecision(state, request) {
  const anchor = parsedDecisionAnchor(request), task = taskFor(state, request.task);
  const candidate = state.lanes[`${request.task}/${request.pick}`]?.candidate;
  if (!candidate) throw new Rejection('unknown_candidate', 'Chosen candidate is unavailable');
  const merged = task.baseSha !== state.mainSha && !(await containsMain(state, candidate.sourceSha));
  if (merged) { const refusal = combinedRejection(candidate, state); if (refusal) throw refusal; }
  if (anchor) {
    const tree = merged ? candidate.combined.treeSha : candidate.treeSha;
    if (!(await treeFiles(tree)).includes(anchor.path))
      throw new Rejection('invalid_anchor', 'Anchor path must be a file in the tree being landed');
  }
  return { valid: true };
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
    const anchor = request.anchor ? parsedDecisionAnchor(request) : undefined;
    const conflictPath = candidates(state, request.task).candidates.flatMap(c => c.conflicts)[0]?.path;
    const basePaths = (await run('git', ['--git-dir', exportRoot, 'ls-tree', '-rz', '--name-only', task.baseSha])).stdout.toString().split('\0').filter(Boolean);
    const path = anchor?.path ?? (conflictPath && basePaths.includes(conflictPath) ? conflictPath : basePaths[0]);
    if (!path) throw new Rejection('missing_anchor', 'Discussion needs a file in the task base');
    result = await heddle(['discuss', 'new', `--path=${path}`,  ...(anchor?.symbol ? ['--symbol', anchor.symbol] : []), '--thread', task.thread, '--title', `${request.task}: ${author.displayName}`, '--body', request.body], task.path, author);
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
  // A pick from an older base lands as Heddle's merge with main only once that merge was tested and
  // passed; until then the combined check says why (running, conflicting, or failing). A pick that
  // already contains main is its own combined result.
  const stale = task.baseSha !== state.mainSha, mergedWithMain = stale && !(await containsMain(state, lane.candidate.sourceSha));
  if (mergedWithMain) { const refusal = combinedRejection(lane.candidate, state); if (refusal) throw refusal; }
  const combined = mergedWithMain ? lane.candidate.combined : undefined;
  const expectedTree = combined ? combined.treeSha : lane.candidate.treeSha;
  await validateDecision(state, request);
  const files = await treeFiles(expectedTree);
  const changed = (await run('git', ['--git-dir', exportRoot, 'diff', '--name-only', '-z', '--diff-filter=ACMRT', await diffBase(state, task, lane.candidate.sourceSha), lane.candidate.sourceSha, '--'])).stdout.toString().split('\0').filter(path => files.includes(path));
  const defaultPath = current.candidates.flatMap(c => c.conflicts).find(c => files.includes(c.path))?.path ?? changed[0] ?? (await treeFiles(task.baseSha)).find(path => files.includes(path));
  const anchor = request.anchor ?? defaultPath;
  if (!anchor) throw new Rejection('missing_anchor', 'Decision needs a file in the tree being landed');
  const alternatives = current.candidates.map(c => c.agent).filter(id => id !== request.pick);
  // G2 fallback b2: absorb only the selected native lane; other alternatives remain addressable.
  const message = `${request.rationale}\n\nHeddle-Task: ${request.task}\nHeddle-Chosen: ${request.pick}\n${alternatives.map(id => `Heddle-Alternative: ${id}`).join('\n')}\n${combined ? `Heddle-Combined: ${combined.sha}\n` : ''}Heddle-Decided-by: ${request.decider}`;
  if (stale) {
    // Heddle integrates main natively. Absorb first records a preparation State on the task thread,
    // which can leave a just-refreshed lane stale ("merge did not run"); refresh onto it and absorb again.
    let merged = false;
    for (let attempt = 0; attempt < 3 && !merged; attempt++) {
      await integrateMain(task, lane, decider);
      await heddle(['thread', 'absorb', lane.thread, '--into', task.thread, '-m', message], task.path, decider, { raw: true, allowFailure: true });
      merged = await descendsFrom((await heddle(['show', task.thread], task.path, decider)).state_id_full, lane.candidate.state);
    }
    if (!merged) throw new Rejection('combined_conflict', 'Heddle could not absorb the chosen work on top of main');
  } else await heddle(['thread', 'absorb', lane.thread, '--into', task.thread, '-m', message], task.path, decider);
  const decisionTurn = await discuss(state, { task: request.task, author: request.decider, body: request.rationale, anchor });
  const resolutionRecord = await heddle(['discuss', 'resolve', decisionTurn.heddleDiscussion, '--mode', 'into-annotation', '--kind', 'rationale', ...(request.tags ?? []).map(tag => `--tag=${tag}`), '--body', request.rationale], task.path, decider);
  // b2 can fast-forward: the selected State keeps its original agent signature.
  // The human's custodial attestation signs the exact native resolution envelope.
  const resolution = await heddle(['show', task.thread], task.path, decider);
  if (resolution.state_id_full === lane.candidate.state) await verifyCapture(join(repoRoot, '.heddle'), resolution, state.agents[request.pick].publicKey);
  else {
    // Integrating main makes a merge State on top of the agent's signed Capture. The Capture keeps the
    // agent's signature; the merge must descend from it and hold exactly the tree that was tested.
    await verifyCapture(join(repoRoot, '.heddle'), await heddle(['show', lane.candidate.state], task.path, decider), state.agents[request.pick].publicKey);
    if (!stale || !(await descendsFrom(resolution.state_id_full, lane.candidate.state))) throw new Rejection('identity_mismatch', 'Resolution does not descend from the chosen signed Capture');
    if ((await nativeTrees([task.thread]))[task.thread] !== expectedTree) throw new Rejection('tree_mismatch', 'Heddle merged result differs from the tested combined tree');
  }
  await heddle(['land', '--thread', task.thread, '-m', message], task.path, decider);
  const landed = await heddle(['show', 'main'], repoRoot, decider);
  const native = await exportProjection({ ...state, projection: undefined });
  if (native.tree !== expectedTree) throw new Rejection('tree_mismatch', 'Heddle landed content differs from the selected work');
  const change = /Heddle-Change: (\S+)/.exec(native.message)?.[1];
  if (!change) throw new Error('Native projection omitted change trailer');
  // A b2 fast-forward retains the candidate Capture's creation time. The
  // decision belongs to this native rationale turn, not that earlier Capture.
  // Persist the same native timestamp in both the decision and projection pin.
  state.projection = { parentSha: state.mainSha, treeSha: native.tree, author: decider.displayName,
    email: actorEmail(decider), at: decisionTurn.at,
    message: `${message}\n\nHeddle-State: ${landed.state_id_full}\nHeddle-Change: ${change}` };
  const mainSha = (await exportProjection(state)).sha;
  /** @type {Decision} */
  const decision = { task: request.task, decider: request.decider, pick: request.pick, rationale: request.rationale, anchor, ...(request.tags !== undefined ? { tags: [...request.tags] } : {}), alternatives,
    resolutionState: resolution.state_id_full, landState: landed.state_id_full, mainSha, at: decisionTurn.at,
    // Landed as Heddle's merge of the pick with main: the exact commit and tree the sandbox tested.
    ...(combined ? { combined: { sha: combined.sha, treeSha: combined.treeSha, mainSha: combined.mainSha, state: combined.state } } : {}) };
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
