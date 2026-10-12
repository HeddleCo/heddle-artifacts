// SPDX-License-Identifier: Apache-2.0
// The combined check: a candidate whose task started before main advanced is merged with the
// current main by Heddle itself (a scratch thread refreshed onto main), its readiness verdict is
// recorded, and the merged state is projected to Git so the isolated sandbox can test it.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run, git, Rejection } from './process.mjs';
import { stateRoot, repoRoot, exportRoot, heddle } from './state.mjs';
import { fixedIdentity } from './git.mjs';

export const COMBINED_REF = 'refs/heads/combined';
const ENGINE = { id: '_engine', displayName: 'Heddle engine' };

/** True when the candidate commit already contains the current main, so its own tests are the combined result. */
export async function containsMain(state, sha) {
  return (await run('git', ['--git-dir', exportRoot, 'merge-base', '--is-ancestor', state.mainSha, sha], { allowFailure: true })).code === 0;
}

/** A candidate needs a combined check when its task's base is behind main and it has not merged main itself. */
export async function needsCombined(state, task, candidate) {
  return task.baseSha !== state.mainSha && !(await containsMain(state, candidate.sourceSha));
}

// One ref per combined commit: it is never rewritten, so publishing it is always a fast-forward create.
export function combinedRef(task, agent, sha) { return `${COMBINED_REF}/${task}/${agent}/${sha}`; }

function parse(text) { try { return JSON.parse(text); } catch { return undefined; } }

/** Heddle's readiness verdict, reduced to the fields the board and the decision rule use. */
export function readinessVerdict(readiness) {
  if (!readiness || typeof readiness !== 'object') throw new Error('Heddle readiness verdict missing');
  const list = value => Array.isArray(value) ? value.slice(0, 20).map(v => String(v).slice(0, 300)) : [];
  return { status: String(readiness.status ?? 'unknown'), freshness: String(readiness.freshness ?? 'unknown'), mergeType: String(readiness.merge_type ?? 'unknown'),
    conflictCount: Number.isSafeInteger(readiness.conflict_count) ? readiness.conflict_count : 0, impact: String(readiness.impact ?? 'unknown'),
    impactCategories: list(readiness.impact_categories), blockers: list(readiness.blockers) };
}

/** Heddle's own conflict list (`heddle resolve --list`): path, symbol and merged line range. */
export function heddleConflicts(listed) {
  return (Array.isArray(listed?.conflicts) ? listed.conflicts : []).slice(0, 50).map(c => ({ path: String(c.path),
    ...(c.symbol ? { symbol: String(c.symbol) } : {}),
    ...(Number.isSafeInteger(c.merged_range?.start_line) && Number.isSafeInteger(c.merged_range?.end_line) ? { lines: [c.merged_range.start_line, c.merged_range.end_line] } : {}) }));
}

/** Merge one candidate's native state with main in a scratch thread. Never touches the agent's lane thread. */
async function mergeWithMain(state, candidate) {
  const name = `combined/${candidate.task}/${candidate.agent}-${randomBytes(6).toString('hex')}`;
  const path = join(stateRoot, 'combined', name.replaceAll('/', '_'));
  await heddle(['start', name, '--from', candidate.state, '--path', path, '--workspace', 'solid', '--no-daemon']);
  const refreshed = await heddle(['thread', 'refresh', name], repoRoot, ENGINE, { raw: true, allowFailure: true });
  let conflicts = [];
  if (refreshed.code !== 0) {
    const error = parse(refreshed.stderr.toString()) ?? parse(refreshed.stdout.toString());
    if (error?.kind !== 'thread_refresh_conflicted') throw new Error('Heddle could not refresh the combined thread');
    conflicts = heddleConflicts(await heddle(['--repo', path, 'resolve', '--list'], path));
    if (!conflicts.length) throw new Error('Heddle reported a conflicted refresh without conflicts');
  }
  const ready = await heddle(['ready', '--thread', name], repoRoot, ENGINE, { raw: true, allowFailure: true });
  const verdict = readinessVerdict((parse(ready.stdout.toString()) ?? parse(ready.stderr.toString()))?.readiness);
  const merged = conflicts.length ? undefined : await heddle(['show', name]);
  return { name, path, conflicts, verdict, mergedState: merged?.state_id_full };
}

async function dropScratch(merge) {
  await heddle(['thread', 'drop', '--force', '--delete-thread', merge.name], repoRoot, ENGINE, { raw: true, allowFailure: true });
  await rm(merge.path, { recursive: true, force: true });
}

/** Export the native repository once and copy each named thread's tree into the engine's Git store. */
export async function nativeTrees(names) {
  const temp = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'heddle-combined-'));
  try {
    const native = join(temp, 'native.git');
    const exported = await heddle(['bridge', 'git', 'export', '--destination', native], repoRoot, ENGINE, { raw: true, allowFailure: true });
    // Same tolerated stock 0.30.0 quirk as the main projection: lane refs may report divergence.
    if (exported.code !== 0 && !(exported.code === 74 && /^exported \d+ refs?, \d+ diverged \(concurrent git-side update\):/.test(parse(exported.stderr.toString())?.error || ''))) throw new Error('Native Git export failed');
    const trees = {};
    for (const name of names) {
      await git(exportRoot, ['fetch', '--no-tags', '--no-write-fetch-head', native, `+refs/heads/${name}:refs/heddle-native/${name}`]);
      trees[name] = await git(exportRoot, ['rev-parse', `refs/heddle-native/${name}^{tree}`]);
      await git(exportRoot, ['update-ref', '-d', `refs/heddle-native/${name}`]);
    }
    return trees;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/**
 * Bring every active candidate of a task up to date with the current main. Idempotent: a candidate
 * already checked against this main, or one that contains main, is left alone. Returns the Git refs
 * the caller must push to the canonical repository so the isolated sandbox can fetch them.
 */
export async function refreshCombined(state, taskId, { isolate = false } = {}) {
  const task = state.tasks[taskId], refs = [];
  if (!task || state.decisions[taskId]) return refs;
  const lanes = Object.values(state.lanes).filter(l => l.task === taskId && l.candidate && l.status === 'active');
  const work = [];
  for (const lane of lanes) {
    const candidate = lane.candidate;
    if (!(await needsCombined(state, task, candidate))) {
      if (candidate.combined) { delete candidate.combined; lane.seen[candidate.sourceSha] = candidate; }
      continue;
    }
    if (candidate.combined?.mainSha === state.mainSha && candidate.combined.candidateSha === candidate.sourceSha) continue;
    work.push(lane);
  }
  if (!work.length) return refs;
  const merges = [];
  try {
    for (const lane of work) merges.push({ lane, merge: await mergeWithMain(state, lane.candidate) });
    const clean = merges.filter(m => !m.merge.conflicts.length);
    const trees = clean.length ? await nativeTrees(clean.map(m => m.merge.name)) : {};
    for (const { lane, merge } of merges) {
      const candidate = lane.candidate;
      const base = { mainSha: state.mainSha, mainState: state.mainState, candidateSha: candidate.sourceSha, heddle: merge.verdict };
      if (merge.conflicts.length) {
        candidate.combined = { ...base, status: 'conflict', conflicts: merge.conflicts };
      } else {
        const treeSha = trees[merge.name];
        const paths = (await run('git', ['--git-dir', exportRoot, 'ls-tree', '-rz', '--name-only', treeSha])).stdout.toString().split('\0').filter(Boolean);
        if (paths.some(p => p.split('/').includes('.heddle') || p.split('/').includes('.git'))) throw new Rejection('invalid_tree', 'Combined tree cannot contain repository metadata');
        const message = `Combined check: ${taskId}/${candidate.agent} with main\n\nCandidate: ${candidate.sourceSha}\nMain: ${state.mainSha}\nHeddle-State: ${merge.mergedState}\n`;
        const sha = await git(exportRoot, ['commit-tree', treeSha, '-p', state.mainSha, '-p', candidate.sourceSha], { input: message, env: fixedIdentity() });
        const ref = combinedRef(taskId, candidate.agent, sha);
        await git(exportRoot, ['update-ref', ref, sha]);
        refs.push(ref);
        candidate.combined = { ...base, status: isolate ? 'pending' : 'skipped', conflicts: [], state: merge.mergedState, sha, treeSha,
          tests: isolate ? { status: 'pending', passed: 0, failed: 0, summary: 'Combined tests pending in the isolated sandbox', durationMs: 0, provenance: 'isolated sandbox', sourceSha: sha }
            : { status: 'skipped', passed: 0, failed: 0, summary: 'Combined tests run only in the isolated sandbox', durationMs: 0 } };
      }
      lane.seen[candidate.sourceSha] = candidate;
    }
  } finally { for (const { merge } of merges) await dropScratch(merge); }
  return refs;
}

/**
 * Why a pick from an older base cannot land yet, or undefined when Heddle merged it with the current
 * main cleanly and the merged result passed its isolated tests: then the human may land that merge.
 */
export function combinedRejection(candidate, state) {
  const combined = candidate.combined;
  if (!combined || combined.mainSha !== state.mainSha || combined.candidateSha !== candidate.sourceSha || combined.status === 'pending')
    return new Rejection('combined_pending', 'Main advanced; the check of this candidate combined with main has not finished');
  if (combined.status === 'conflict')
    return new Rejection('combined_conflict', `Heddle found conflicts with main in ${combined.conflicts.map(c => c.symbol ? `${c.path} (${c.symbol})` : c.path).join(', ')}; the agent must resolve them and push again`);
  if (combined.status === 'fail' || combined.status === 'error') {
    const t = combined.tests;
    return new Rejection('combined_failing', t?.status === 'fail' ? `${t.failed} test${t.failed === 1 ? '' : 's'} fail combined with main; the agent must fix them on the combined commit and push again`
      : 'The combined result could not be tested; the agent must update its candidate from the combined commit and push again');
  }
  if (combined.status !== 'pass') return new Rejection('combined_untested', 'Main advanced; the result combined with main was not tested in the isolated sandbox');
  return undefined;
}

/** Bring the task thread and the chosen lane up to date with main natively, so the absorb sees main. */
export async function integrateMain(task, lane, decider) {
  for (const thread of [task.thread, lane.thread]) {
    const shown = await heddle(['thread', 'show', thread], repoRoot, decider);
    if (shown.freshness === 'current') continue;
    const refreshed = await heddle(['thread', 'refresh', thread], repoRoot, decider, { raw: true, allowFailure: true });
    if (refreshed.code !== 0) throw new Rejection('combined_conflict', 'Heddle could not merge the chosen work with main; ask the agent to resolve and push again');
  }
}

/** True when `ancestor` is reachable from `state` through Heddle parents (bounded walk). */
export async function descendsFrom(state, ancestor, cwd = repoRoot) {
  const seen = new Set(), queue = [state];
  while (queue.length && seen.size < 64) {
    const id = queue.shift(); if (seen.has(id)) continue; seen.add(id);
    if (ancestor.startsWith(id) || id.startsWith(ancestor)) return true;
    const shown = await heddle(['show', id], cwd);
    if (shown.state_id_full === ancestor) return true;
    for (const parent of shown.parents ?? []) queue.push(parent);
  }
  return false;
}
