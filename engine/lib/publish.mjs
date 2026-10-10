// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run, git, gitAuth, remote, Rejection } from './process.mjs';
import { stateRoot, repoRoot, exportRoot, heddle, actorEnv, relocate } from './state.mjs';
import { fixedIdentity, note } from './git.mjs';
import { narrative } from './why.mjs';
import { exportProjection } from './projection.mjs';

export async function verifyProjection(state, expectedSha) {
  const temp = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'heddle-verify-'));
  try {
    const archive = join(temp, 'state.tar.zst'), restored = join(temp, 'restored');
    await run('tar', ['--zstd', '--exclude=node_modules', '-cf', archive, '-C', stateRoot, '.']);
    await mkdir(restored);
    await run('tar', ['--zstd', '-xf', archive, '-C', restored]);
    await relocate(restored, stateRoot, restored);
    const roundTrip = join(restored, 'export.git');
    await exportProjection(state, roundTrip, join(restored, 'repo'));
    const roundTripSha = await git(roundTrip, ['rev-parse', 'main']);
    const exportRoundTrip = roundTripSha === expectedSha;
    const lastDecision = Object.values(state.decisions).at(-1);
    const treeMatch = !lastDecision || await git(exportRoot, ['rev-parse', 'main^{tree}']) === state.lanes[`${lastDecision.task}/${lastDecision.pick}`].candidate.treeSha;
    const clone = join(temp, 'clone');
    await git(temp, ['clone', '--no-local', '--', exportRoot, clone]);
    await git(clone, ['fsck', '--strict']);
    const pack = (await run('git', ['--git-dir', exportRoot, 'pack-objects', '--all', '--stdout'], { maxBytes: 64 * 1024 * 1024 })).stdout;
    await run('git', ['index-pack', '--strict', '--stdin'], { cwd: clone, input: pack });
    return { exportRoundTrip, treeMatch, fsck: true };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function remoteNotes(remoteUrl) {
  const refs = await git(exportRoot, ['ls-remote', remoteUrl, 'refs/notes/heddle', 'refs/notes/heddle-why'], { env: gitAuth(remoteUrl) });
  const tips = {};
  for (const row of refs.split('\n').filter(Boolean)) {
    const [sha, ref] = row.split('\t');
    await git(exportRoot, ['fetch', '--no-tags', '--no-write-fetch-head', remoteUrl, `${ref}:refs/heddle-remote/${ref.slice('refs/notes/'.length)}`], { env: gitAuth(remoteUrl) });
    tips[ref] = sha;
  }
  return tips;
}

async function parentNotes(ref, parent) {
  if (!parent) return;
  const tip = await git(exportRoot, ['rev-parse', ref]);
  const ancestry = await run('git', ['--git-dir', exportRoot, 'merge-base', '--is-ancestor', parent, tip], { allowFailure: true });
  if (ancestry.code === 0) return;
  const tree = await git(exportRoot, ['rev-parse', `${tip}^{tree}`]);
  // R1: preserve Heddle's machine-note tree verbatim and parent on the remote tip.
  const commit = await git(exportRoot, ['commit-tree', tree, '-p', parent], { input: 'Heddle notes generation\n', env: fixedIdentity() });
  await git(exportRoot, ['update-ref', ref, commit]);
}

async function agentsBranch(state) {
  const agents = Object.values(state.agents).sort((a, b) => a.id.localeCompare(b.id));
  const blob = await git(exportRoot, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(agents, null, 2) + '\n' });
  const tree = await git(exportRoot, ['mktree'], { input: `100644 blob ${blob}\t.heddle-agents.json\n` });
  const current = await run('git', ['--git-dir', exportRoot, 'rev-parse', '--verify', 'refs/heads/heddle/agents'], { allowFailure: true });
  const parent = current.code === 0 ? current.stdout.toString().trim() : undefined;
  if (parent && await git(exportRoot, ['rev-parse', `${parent}^{tree}`]) === tree) return;
  const commit = await git(exportRoot, ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], { input: 'Heddle agent directory\n', env: fixedIdentity() });
  await git(exportRoot, ['update-ref', 'refs/heads/heddle/agents', commit]);
}

export async function publish(state, request) {
  const target = remote(request.canonical?.remote);
  if (target !== state.canonical) throw new Rejection('canonical_mismatch', 'Publish remote differs from the registered canonical repo');
  const notesTips = await remoteNotes(target);
  const projected = await exportProjection(state);
  const main = projected.sha;
  // Pin the projected main at decision time. A fresh export cannot silently drift.
  if (main !== state.mainSha) throw new Rejection('export_drift', 'Export differs from the recorded Heddle projection');
  for (const lane of Object.values(state.lanes).filter(l => l.candidate)) {
    const tip = await git(exportRoot, ['ls-remote', lane.remote, 'refs/heads/main'], { env: gitAuth(lane.remote) });
    if (tip.split('\t')[0] !== lane.candidate.sourceSha) throw new Rejection('candidate_changed', 'Fork main changed; ingest its latest push before publishing');
    const ref = `refs/heads/candidates/${lane.task}/${lane.agent}`;
    if (await git(exportRoot, ['rev-parse', ref]) !== lane.candidate.sourceSha) throw new Rejection('candidate_drift', 'Candidate ref differs from the original pushed commit');
    state.narratives[lane.candidate.sourceSha] = narrative(state, lane.task, state.decisions[lane.task]);
  }
  for (const decision of Object.values(state.decisions)) state.narratives[decision.mainSha] = narrative(state, decision.task, decision);
  for (const [sha, text] of Object.entries(state.narratives)) await note(sha, text, Object.values(state.decisions).find(d => d.mainSha === sha)?.at);
  await agentsBranch(state);
  for (const ref of ['refs/notes/heddle', 'refs/notes/heddle-why']) await parentNotes(ref, notesTips[ref]);
  const verify = await verifyProjection(state, main);
  if (!verify.exportRoundTrip || !verify.treeMatch || !verify.fsck) throw new Rejection('verification_failed', 'Git projection verification failed');
  const refs = ['refs/heads/main', 'refs/heads/heddle/agents', ...Object.values(state.lanes).filter(l => l.candidate).map(l => `refs/heads/candidates/${l.task}/${l.agent}`), 'refs/notes/heddle', 'refs/notes/heddle-why'];
  await git(exportRoot, ['push', target, ...refs.map(ref => `${ref}:${ref}`)], { env: gitAuth(target, true) });
  return { main, pushed: refs, verify };
}
