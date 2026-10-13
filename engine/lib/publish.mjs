// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run, git, gitAuth, remote, Rejection } from './process.mjs';
import { stateRoot, exportRoot, relocate, requestHash, save } from './state.mjs';
import { fixedIdentity } from './git.mjs';
import { narrative } from './why.mjs';
import { exportProjection } from './projection.mjs';
import { orderedPublish, DIRECTORY_REF, MANIFEST_PATH, leasedPushArgs } from './ordered-publication.mjs';

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
    // A pick merged with main by Heddle lands the tested combined tree, not the pick's own tree.
    const treeMatch = !lastDecision || await git(exportRoot, ['rev-parse', 'main^{tree}']) === (lastDecision.combined?.treeSha ?? state.lanes[`${lastDecision.task}/${lastDecision.pick}`].candidate.treeSha);
    const clone = join(temp, 'clone');
    await git(temp, ['clone', '--no-local', '--', exportRoot, clone]);
    await git(clone, ['fsck', '--strict']);
    const pack = (await run('git', ['--git-dir', exportRoot, 'pack-objects', '--all', '--stdout'], { maxBytes: 64 * 1024 * 1024 })).stdout;
    await run('git', ['index-pack', '--strict', '--stdin'], { cwd: clone, input: pack });
    return { exportRoundTrip, treeMatch, fsck: true };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

const oidPattern = /^[0-9a-f]{40}$/;
const canonicalJSON = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item, 2) + '\n';
const reject = message => { throw new Rejection('publication_conflict', message); };

async function readRefs(target, refs) {
  const rows = await git(exportRoot, ['ls-remote', target, ...refs], { env: gitAuth(target), protocol: 2 });
  const result = Object.fromEntries(refs.map(ref => [ref, null]));
  for (const row of rows.split('\n').filter(Boolean)) {
    const [oid, ref] = row.split('\t');
    if (Object.hasOwn(result, ref)) result[ref] = oid;
  }
  return result;
}

async function fetchObject(target, oid) {
  if (!oidPattern.test(oid)) reject('Invalid publication object ID');
  await git(exportRoot, ['fetch', '--no-tags', '--no-write-fetch-head', target, oid], { env: gitAuth(target), protocol: 2 });
  if (await git(exportRoot, ['cat-file', '-t', oid]) !== 'commit') reject('Publication object is not a commit');
}

// Public read-only resolver: main selects immutable proofs, not current aliases.
// The first parent is always the preceding directory (or a fixed empty root).
export async function resolvePublication(directoryTip, main, repository = exportRoot) {
  if (!directoryTip) return null;
  if (!oidPattern.test(directoryTip) || !oidPattern.test(main)) reject('Invalid publication lookup');
  const commits = (await git(repository, ['rev-list', '--first-parent', directoryTip])).split('\n').filter(Boolean);
  let found = null;
  for (const oid of commits) {
    const file = await run('git', ['--git-dir', repository, 'show', `${oid}:${MANIFEST_PATH}`], { allowFailure: true });
    if (file.code !== 0) continue; // A legacy directory or the empty root.
    let manifest; try { manifest = JSON.parse(file.stdout); } catch { reject('Malformed publication manifest'); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) reject('Invalid publication manifest');
    if (manifest.format !== 1 || !oidPattern.test(manifest.main) || !oidPattern.test(manifest.expectedMain) || manifest.main === manifest.expectedMain ||
        !/^[0-9a-f]{64}$/.test(manifest.inputHash) || !manifest.refs || typeof manifest.refs !== 'object' || Array.isArray(manifest.refs) ||
        !Object.hasOwn(manifest.refs, 'refs/notes/heddle') || !Object.hasOwn(manifest.refs, 'refs/notes/heddle-why') ||
        ['exportRoundTrip', 'treeMatch', 'fsck'].some(key => manifest.verify?.[key] !== true) ||
        (manifest.directoryBefore !== null && !oidPattern.test(manifest.directoryBefore))) reject('Invalid publication manifest');
    for (const [ref, value] of Object.entries(manifest.refs)) {
      if (!/^refs\/(?:notes\/heddle(?:-why)?|heads\/candidates\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)$/.test(ref) ||
          !oidPattern.test(value?.oid) || (value.before !== null && !oidPattern.test(value.before))) reject('Invalid publication ref pin');
    }
    const parents = (await git(repository, ['show', '-s', '--format=%P', oid])).split(' ').filter(Boolean);
    if (manifest.directoryBefore && parents[0] !== manifest.directoryBefore) reject('Publication directory history differs from its declared predecessor');
    for (const value of new Set([manifest.main, ...Object.values(manifest.refs).map(item => item.oid)])) {
      if (!parents.includes(value) && (await run('git', ['--git-dir', repository, 'merge-base', '--is-ancestor', value, oid], { allowFailure: true })).code !== 0)
        reject('Publication objects are not retained by the directory commit');
    }
    if (manifest.main === main) {
      if (found) reject('More than one immutable publication claims this main');
      found = { oid, manifest };
    }
  }
  return found;
}

async function isAncestor(parent, child) {
  return (await run('git', ['--git-dir', exportRoot, 'merge-base', '--is-ancestor', parent, child], { allowFailure: true })).code === 0;
}

async function commitTree(tree, parents, message) {
  return git(exportRoot, ['commit-tree', tree, ...[...new Set(parents.filter(Boolean))].flatMap(parent => ['-p', parent])],
    { input: message + '\n', env: fixedIdentity() });
}

async function noteCommit(tree, before, label) {
  if (before && await git(exportRoot, ['rev-parse', `${before}^{tree}`]) === tree) return before;
  return commitTree(tree, [before], label);
}

async function prepareManifest(input, inputHash, before, verify) {
  const refs = {};
  for (const lane of Object.values(input.lanes).sort((a, b) => `${a.task}/${a.agent}`.localeCompare(`${b.task}/${b.agent}`))) {
    const ref = `refs/heads/candidates/${lane.task}/${lane.agent}`;
    refs[ref] = { oid: lane.candidate.sourceSha, before: before[ref] || null };
  }
  // Native machine-note bytes are frozen at decision time, and never remapped.
  const machineTree = await git(exportRoot, ['rev-parse', `${input.machineNotes}^{tree}`]);
  refs['refs/notes/heddle'] = { oid: await noteCommit(machineTree, before['refs/notes/heddle'], 'Heddle native notes snapshot'), before: before['refs/notes/heddle'] || null };
  const whyRef = 'refs/notes/heddle-publication-work';
  if (before['refs/notes/heddle-why']) await git(exportRoot, ['update-ref', whyRef, before['refs/notes/heddle-why']]);
  else await git(exportRoot, ['update-ref', '-d', whyRef]);
  const narratives = { ...input.narratives };
  for (const lane of Object.values(input.lanes)) {
    narratives[lane.candidate.sourceSha] ??= narrative(input, lane.task, input.decisions[lane.task]);
  }
  for (const decision of Object.values(input.decisions)) {
    if (!narratives[decision.mainSha]) reject('Decision-time rationale is missing');
  }
  for (const [sha, text] of Object.entries(narratives).sort(([a], [b]) => a.localeCompare(b))) {
    const existing = await run('git', ['--git-dir', exportRoot, 'notes', `--ref=${whyRef}`, 'show', sha], { allowFailure: true });
    if (existing.code === 0 && existing.stdout.toString() === text + '\n') continue;
    if (existing.code === 0 && Object.values(input.decisions).some(decision => decision.mainSha === sha)) reject('An existing landed rationale differs from the frozen decision');
    // -C reuses exact blob bytes; -F would strip whitespace from signed prose.
    const blob = await git(exportRoot, ['hash-object', '-w', '--stdin'], { input: text + '\n' });
    await git(exportRoot, ['notes', `--ref=${whyRef}`, 'add', '-f', '-C', blob, sha], { env: fixedIdentity() });
  }
  const whyTree = await git(exportRoot, ['rev-parse', `${whyRef}^{tree}`]);
  refs['refs/notes/heddle-why'] = { oid: await noteCommit(whyTree, before['refs/notes/heddle-why'], 'Heddle rationale snapshot'), before: before['refs/notes/heddle-why'] || null };
  const manifest = { format: 1, main: input.mainSha, expectedMain: input.projection.parentSha,
    inputHash, directoryBefore: before[DIRECTORY_REF] || null, refs, verify };
  const agents = Object.values(input.agents).sort((a, b) => a.id.localeCompare(b.id));
  const agentBlob = await git(exportRoot, ['hash-object', '-w', '--stdin'], { input: canonicalJSON(agents) });
  const manifestBlob = await git(exportRoot, ['hash-object', '-w', '--stdin'], { input: canonicalJSON(manifest) });
  const tree = await git(exportRoot, ['mktree'], { input: `100644 blob ${agentBlob}\t.heddle-agents.json\n100644 blob ${manifestBlob}\t${MANIFEST_PATH}\n` });
  const emptyTree = await git(exportRoot, ['mktree'], { input: '' });
  const root = before[DIRECTORY_REF] || await commitTree(emptyTree, [], 'Heddle publication directory root');
  const oid = await commitTree(tree, [root, input.mainSha, ...Object.values(refs).map(value => value.oid)], 'Heddle immutable publication snapshot');
  return { oid, manifest };
}

export async function publish(state, request) {
  const target = remote(request.canonical?.remote);
  if (target !== state.canonical) throw new Rejection('canonical_mismatch', 'Publish remote differs from the registered canonical repo');
  if (!state.projection) throw new Rejection('publication_requires_decision', 'Publication requires a recorded decision');
  if (!state.publicationInput) throw new Rejection('publication_input_missing', 'This decision predates immutable publication inputs; explicit recovery is required');
  const { input, hash } = state.publicationInput;
  if (hash !== requestHash(input) || input.mainSha !== state.mainSha || input.canonical !== target)
    throw new Rejection('publication_input_drift', 'The frozen publication input changed');
  if (state.pendingPublication && state.pendingPublication.main !== input.mainSha) reject('Another locally checkpointed publication is still pending');
  for (const lane of Object.values(input.lanes)) {
    const ref = `refs/heads/candidates/${lane.task}/${lane.agent}`;
    // A genuine later ingest may move an open alias, but cannot change the frozen
    // decision. Detect local ref tampering when the current state still names it.
    if (state.lanes[`${lane.task}/${lane.agent}`]?.candidate?.sourceSha === lane.candidate.sourceSha &&
        await git(exportRoot, ['rev-parse', ref]) !== lane.candidate.sourceSha)
      throw new Rejection('candidate_drift', 'Candidate ref differs from the original pushed commit');
  }
  const refs = ['refs/heads/main', DIRECTORY_REF, ...Object.values(input.lanes).map(lane => `refs/heads/candidates/${lane.task}/${lane.agent}`), 'refs/notes/heddle', 'refs/notes/heddle-why'];
  const tips = await readRefs(target, refs);
  if (tips['refs/heads/main'] !== input.mainSha && tips['refs/heads/main'] !== input.projection.parentSha)
    reject('Canonical main differs from the decision and its expected parent');
  if (tips[DIRECTORY_REF]) await fetchObject(target, tips[DIRECTORY_REF]);
  const existing = await resolvePublication(tips[DIRECTORY_REF], input.mainSha);
  if (existing && existing.manifest.inputHash !== hash) reject('The remote publication binds different decision inputs');
  if (!existing && tips['refs/heads/main'] === input.mainSha) reject('Landed main has no recoverable publication receipt');
  // Recreate from the ORIGINAL baseline, never from mutable current aliases.
  const checkpoint = state.pendingPublication?.main === input.mainSha ? state.pendingPublication : null;
  if (checkpoint && existing && checkpoint.oid !== existing.oid) reject('The remote receipt differs from the locally checkpointed publication');
  const pinned = existing || checkpoint;
  const before = pinned ? { [DIRECTORY_REF]: pinned.manifest.directoryBefore,
    ...Object.fromEntries(Object.entries(pinned.manifest.refs).map(([ref, value]) => [ref, value.before])) } : tips;
  if (!pinned && tips[DIRECTORY_REF]) {
    const previous = await resolvePublication(tips[DIRECTORY_REF], input.projection.parentSha);
    // Do not supersede another decision's still-pending publication.
    const tipManifest = await resolvePublication(tips[DIRECTORY_REF], input.mainSha);
    const atTip = await run('git', ['--git-dir', exportRoot, 'show', `${tips[DIRECTORY_REF]}:${MANIFEST_PATH}`], { allowFailure: true });
    if (atTip.code === 0 && (!previous || previous.oid !== tips[DIRECTORY_REF]) && !tipManifest) reject('Another publication is pending in the directory');
  }
  for (const oid of new Set(Object.values(before).filter(Boolean))) {
    if (!oidPattern.test(oid)) reject('Invalid publication baseline');
    const available = await run('git', ['--git-dir', exportRoot, 'cat-file', '-e', `${oid}^{commit}`], { allowFailure: true });
    if (available.code !== 0) await fetchObject(target, oid);
  }
  const projected = await exportProjection(state);
  if (projected.sha !== input.mainSha) throw new Rejection('export_drift', 'Export differs from the recorded Heddle projection');
  const verify = await verifyProjection(state, input.mainSha);
  if (!verify.exportRoundTrip || !verify.treeMatch || !verify.fsck) throw new Rejection('verification_failed', 'Git projection verification failed');
  const prepared = await prepareManifest(input, hash, before, verify);
  if (pinned && prepared.oid !== pinned.oid) reject('The immutable publication snapshot does not match the frozen inputs');
  for (const [ref, value] of Object.entries(prepared.manifest.refs)) {
    if (value.before && !await isAncestor(value.before, value.oid)) reject(`Publication would replace non-ancestor history for ${ref}`);
  }
  if (!await isAncestor(input.projection.parentSha, input.mainSha)) reject('The selected main is not a descendant of its expected parent');
  const fingerprint = requestHash(request);
  state.publicationRequests ||= Object.create(null);
  const bound = state.publicationRequests[request.opId];
  if (bound && bound !== fingerprint) throw new Rejection('op_id_conflict', 'Publication opId is bound to different input');
  state.publicationRequests[request.opId] = fingerprint;
  state.pendingPublication = { ...prepared, main: input.mainSha };
  await git(exportRoot, ['update-ref', `refs/heddle-publications/${input.mainSha}`, prepared.oid]);
  await save(state); // Durable checkpoint precedes every remote mutation.
  await orderedPublish({ manifest: prepared.manifest, directoryOid: prepared.oid,
    readRefs: names => readRefs(target, names),
    pushRefs: updates => git(exportRoot, leasedPushArgs(target, updates), { env: gitAuth(target, true) }),
    verifySnapshot: async directoryTip => {
      if (!directoryTip) reject('The remote publication directory is missing');
      await fetchObject(target, directoryTip);
      const receipt = await resolvePublication(directoryTip, input.mainSha);
      if (!receipt || receipt.oid !== prepared.oid) reject('The exact publication receipt is not retained remotely');
      await git(exportRoot, ['fsck', '--strict', '--no-reflogs', receipt.oid]);
    },
  });
  delete state.pendingPublication;
  return { main: input.mainSha, pushed: refs, verify };
}
