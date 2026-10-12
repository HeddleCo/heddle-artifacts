// SPDX-License-Identifier: Apache-2.0
// Independent protocol tests: only synthetic local repositories and native Heddle.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, git } from '../lib/process.mjs';
import { fixedIdentity } from '../lib/git.mjs';

const engine = process.env.ENGINE_FILE || fileURLToPath(new URL('../engine.mjs', import.meta.url));
const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'ordered-independent-'));
const state = join(root, 'state'), canonical = join(root, 'fixture.git');
const env = { ENGINE_STATE_DIR: state, HEDDLE_BIN: process.env.HEDDLE_BIN || 'heddle', TMPDIR: process.env.TMPDIR || '/tmp' };
let next = 0;
async function invoke(command, body, options = {}) {
  const result = await run(process.execPath, [options.engine || engine, command], {
    env: { ...env, ...options.env }, input: Buffer.isBuffer(body) ? body : JSON.stringify(body), allowFailure: true,
  });
  return { ...result, data: command === 'snapshot' ? result.stdout : (() => { try { return JSON.parse(result.stdout); } catch { return null; } })() };
}
async function call(command, body, options = {}) {
  const result = await invoke(command, body, options);
  assert.equal(result.code, 0, `${command}: ${result.stdout} ${result.stderr}`);
  return result.data;
}
const mutate = (command, body) => call(command, { opId: `independent-${++next}`, ...body });
const refs = () => git(canonical, ['show-ref']);
const main = () => git(canonical, ['rev-parse', 'refs/heads/main']);
const manifest = async (ref = 'refs/heads/heddle/agents') => JSON.parse(await git(canonical, ['show', `${ref}:.heddle-publication.json`]));
const hookPath = join(canonical, 'hooks/update');
const pubRequest = { opId: 'independent-publication', canonical: { remote: canonical } };
const passed = [];
async function pass(name) { passed.push(name); console.log(`PASS ${name}`); }

await mkdir(join(root, 'seed'));
await git(join(root, 'seed'), ['init', '-b', 'main']);
await writeFile(join(root, 'seed/README.md'), '# Independent ordered-publication fixture\n');
await git(join(root, 'seed'), ['add', '.']);
await git(join(root, 'seed'), ['commit', '-m', 'Synthetic initial tree'], { env: fixedIdentity() });
await git(root, ['init', '--bare', '--template=', '--initial-branch=main', canonical]);
// Create this before the baseline copy so every reset also restores the directory.
await assert.rejects(stat(join(canonical, 'hooks')), { code: 'ENOENT' });
await mkdir(join(canonical, 'hooks'));
await git(canonical, ['config', 'receive.advertiseAtomic', 'false']);
const initial = await mutate('init', { project: 'fixture', canonical: { remote: canonical }, seed: { importUrl: join(root, 'seed') } });
await mutate('task.create', { task: 'first', intent: 'Keep exact reviewed proof' });
for (const [id, kind] of [['picked', 'agent'], ['decider', 'human']]) {
  await mutate('agent.enroll', { agent: { id, kind, displayName: id, provider: 'synthetic', model: 'fixture' } });
}
const fork = join(root, 'fixture--first--picked.git'), checkout = join(root, 'checkout');
await git(root, ['clone', '--bare', canonical, fork]);
await mutate('lane.open', { task: 'first', agent: 'picked' });
await git(root, ['clone', fork, checkout]);
await writeFile(join(checkout, 'README.md'), '# Independent selected tree\n');
await git(checkout, ['add', '.']);
await git(checkout, ['commit', '-m', 'Exact reviewed candidate'], { env: fixedIdentity() });
await git(checkout, ['push', 'origin', 'HEAD:main']);
const candidate = await git(checkout, ['rev-parse', 'HEAD']);
await mutate('ingest', { items: [{ task: 'first', agent: 'picked', fork: { remote: fork }, ref: 'refs/heads/main', sha: candidate }], runTests: false });
await mutate('discuss', { task: 'first', author: 'decider', body: 'Reviewed discussion before the decision.  ' });
const heads = (await call('candidates', { task: 'first' })).heads;
const decision = await mutate('decide', { task: 'first', pick: 'picked', decider: 'decider', rationale: 'Freeze the exact reviewed evidence.  \n\nKeep trailing proof bytes.  ', expectHeads: heads });
const originalWhy = (await call('why', { sha: decision.mainSha })).narrative;
const baseline = await call('snapshot', {});
const baselineRemote = join(root, 'baseline.git');
await cp(canonical, baselineRemote, { recursive: true });
async function reset() {
  await rm(canonical, { recursive: true, force: true });
  await cp(baselineRemote, canonical, { recursive: true });
  assert((await stat(join(canonical, 'hooks'))).isDirectory(), 'reset preserves the fixture hook directory');
  await call('restore', baseline);
}
async function expectFrozenWhy() {
  assert.equal(await git(canonical, ['notes', '--ref=heddle-why', 'show', decision.mainSha]), originalWhy);
  assert.equal((await call('why', { sha: decision.mainSha })).narrative, originalWhy);
}
async function assertSnapshot(m, directory) {
  assert.equal(m.main, decision.mainSha);
  assert.equal(m.expectedMain, initial.mainSha);
  assert.equal(m.refs['refs/heads/candidates/first/picked'].oid, candidate);
  for (const [ref, value] of Object.entries(m.refs)) {
    assert.match(value.oid, /^[a-f0-9]{40}$/);
    assert.equal(await git(canonical, ['rev-parse', ref]), value.oid, `${ref} must equal exact prepared snapshot`);
    await git(canonical, ['merge-base', '--is-ancestor', value.oid, directory]);
  }
  const whyOid = m.refs['refs/notes/heddle-why'].oid;
  const notePaths = (await git(canonical, ['ls-tree', '-r', '--name-only', whyOid])).split('\n');
  const notePath = notePaths.find(path => path.replaceAll('/', '') === decision.mainSha);
  assert(notePath, 'pinned why-note tree contains exact decided SHA');
  assert.equal(await git(canonical, ['show', `${whyOid}:${notePath}`]), originalWhy);
}

// An update hook sees the exact remote prefix at each write, independent of client ordering.
const orderLog = join(root, 'order.log');
await writeFile(hookPath, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${orderLog}'\n`, { mode: 0o700 });
const published = await call('publish', pubRequest);
assert.equal(published.main, decision.mainSha);
assert.deepEqual(published.verify, { exportRoundTrip: true, treeMatch: true, fsck: true });
const updates = (await readFile(orderLog, 'utf8')).trim().split('\n');
assert.equal(updates.at(-1), 'refs/heads/main', 'main is the last remote write');
const directory = await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']);
await assertSnapshot(await manifest(), directory);
await expectFrozenWhy();
await pass('non-atomic server succeeds with reachable exact proof objects and main last');

await reset();
const beforePartial = await refs();
await writeFile(hookPath, '#!/bin/sh\n[ "$1" != "refs/notes/heddle-why" ]\n', { mode: 0o700 });
const partial = await invoke('publish', pubRequest);
assert.notEqual(partial.code, 0, 'rejected proof must reject publication');
assert.equal(await main(), initial.mainSha, 'proof failure cannot advance main');
assert.notEqual(await refs(), beforePartial, 'ordered protocol must honestly expose pending auxiliary refs');
const prepared = await manifest();
const pendingDirectory = await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']);
assert.equal(prepared.main, decision.mainSha);
await rm(hookPath);
await call('restore', baseline);
const resumed = await call('publish', pubRequest);
assert.equal(resumed.main, decision.mainSha);
assert.equal(await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']), pendingDirectory, 'restart reuses exact prepared snapshot');
await assertSnapshot(prepared, pendingDirectory);
await pass('partial proof rejection preserves old main and snapshot restore resumes exact prepared bytes');

// Candidate content may remain local and unchanged while main races independently.
await reset();
const remoteTree = await git(canonical, ['rev-parse', `${initial.mainSha}^{tree}`]);
const racer = await git(canonical, ['commit-tree', remoteTree, '-p', initial.mainSha], { input: 'Independent canonical race\n', env: fixedIdentity() });
await writeFile(hookPath, `#!/bin/sh\nif [ "$1" = refs/heads/main ]; then\n  git update-ref refs/heads/main '${racer}' '${initial.mainSha}' || exit 1\nfi\n`, { mode: 0o700 });
const raced = await invoke('publish', pubRequest);
assert.notEqual(raced.code, 0, 'main CAS race must reject');
assert.equal(await main(), racer, 'exact expected-old lease preserves the racing main');
await rm(hookPath);
const racedRefs = await refs();
await call('restore', baseline);
const stale = await invoke('publish', pubRequest);
assert.notEqual(stale.code, 0);
assert.equal(await refs(), racedRefs, 'stale main must reject before any new remote write');
await pass('expected-old main CAS rejects raced and stale canonical head without overwriting it');

// Move main after the last client read but before push's own advertisement. A
// plain fast-forward push would silently recreate a concurrently deleted main;
// the explicit expected-old lease must refuse it.
await reset();
const leaseGit = (await run('sh', ['-c', 'command -v git'])).stdout.toString().trim();
const deletionWrapper = join(root, 'delete-main-before-push');
await mkdir(deletionWrapper);
await writeFile(join(deletionWrapper, 'git'), `#!/bin/sh
is_push=0
is_main=0
for arg in "$@"; do
  [ "$arg" = push ] && is_push=1
  case "$arg" in *:refs/heads/main) is_main=1 ;; esac
done
if [ "$is_push" = 1 ] && [ "$is_main" = 1 ]; then
  '${leaseGit}' --git-dir '${canonical}' update-ref -d refs/heads/main '${initial.mainSha}' || exit 98
fi
exec '${leaseGit}' "$@"
`, { mode: 0o700 });
const deletedRace = await invoke('publish', pubRequest, { env: { PATH: `${deletionWrapper}:${process.env.PATH}` } });
assert.notEqual(deletedRace.code, 0, 'explicit lease must reject even a normally fast-forward recreation');
assert.notEqual((await run('git', ['--git-dir', canonical, 'rev-parse', '--verify', 'refs/heads/main'], { allowFailure: true })).code, 0, 'concurrent main deletion remains authoritative');
await pass('explicit expected-old lease rejects deletion between final read and push advertisement');

// Crash only after all remote writes and verification, before journaling publication success.
await reset();
const crashEngine = join(root, 'crash-engine');
await cp(dirname(engine), crashEngine, { recursive: true });
const crashFile = join(crashEngine, 'engine.mjs');
const crashSource = await readFile(crashFile, 'utf8');
const saveMarker = '          await save(state,';
assert(crashSource.includes(saveMarker));
await writeFile(crashFile, crashSource.replace(saveMarker, "          if (cmd === 'publish') process.exit(86);\n" + saveMarker));
assert.equal((await invoke('publish', pubRequest, { engine: crashFile })).code, 86);
assert.equal(await main(), decision.mainSha);
const landedRefs = await refs();
await call('restore', baseline);
const recovered = await call('publish', pubRequest);
assert.equal(recovered.main, decision.mainSha);
assert.equal(await refs(), landedRefs, 'lost journal recovery must not republish or retcon proof');
await expectFrozenWhy();
await pass('lost post-push acknowledgement recovers identical refs from pre-publication snapshot');

// A transport can apply an individual push but lose the acknowledgement.
const realGit = (await run('sh', ['-c', 'command -v git'])).stdout.toString().trim();
for (const lostRef of ['refs/heads/heddle/agents', 'refs/heads/candidates/first/picked', 'refs/notes/heddle', 'refs/notes/heddle-why', 'refs/heads/main']) {
  await reset();
  if (lostRef.startsWith('refs/heads/candidates/')) await git(canonical, ['update-ref', '-d', lostRef]);
  const wrapperDir = join(root, `git-wrapper-${lostRef.split('/').at(-1)}`);
  await mkdir(wrapperDir, { recursive: true });
  const trigger = join(wrapperDir, 'lose-ack');
  await writeFile(trigger, 'synthetic transport fault');
  await writeFile(join(wrapperDir, 'git'), `#!/bin/sh
is_push=0
matches=0
for arg in "$@"; do
  [ "$arg" = push ] && is_push=1
  case "$arg" in *:${lostRef}) matches=1 ;; esac
done
'${realGit}' "$@"
status=$?
if [ "$status" = 0 ] && [ "$is_push" = 1 ] && [ "$matches" = 1 ] && [ -f '${trigger}' ]; then
  '${process.execPath}' --input-type=commonjs -e 'require("node:fs").unlinkSync(process.argv[1])' '${trigger}'
  exit 97
fi
exit "$status"
`, { mode: 0o700 });
  await invoke('publish', pubRequest, { env: { PATH: `${wrapperDir}:${process.env.PATH}` } });
  assert.equal(await readFile(trigger, 'utf8').catch(error => error.code === 'ENOENT' ? 'consumed' : Promise.reject(error)), 'consumed', `fault must actually trigger for ${lostRef}`);
  const exactPrepared = await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']);
  await call('restore', baseline);
  assert.equal((await call('publish', pubRequest)).main, decision.mainSha);
  assert.equal(await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']), exactPrepared);
  await expectFrozenWhy();
  await pass(`lost acknowledgement after ${lostRef} resumes exact snapshot`);
}

// New legitimate discussion is not historical decision evidence.
await mutate('discuss', { task: 'first', author: 'decider', body: 'LATER COMMENT: must not rewrite landed rationale.' });
const beforeRepublish = await refs();
const republish = await call('publish', { ...pubRequest, opId: 'republish-after-discussion' });
assert.equal(republish.main, decision.mainSha);
await expectFrozenWhy();
assert.equal(await refs(), beforeRepublish, 'already-landed main is verification-only despite later discussions');
await pass('later discussion cannot retcon landed rationale or rewrite its pinned publication');
assert.equal((await call('publish', { ...pubRequest, opId: 'constructor' })).main, decision.mainSha, 'prototype-named opId is valid and bound safely');
await pass('prototype-named publication opId stays within ordinary replay semantics');

// A later publisher can expose a new directory/notes while current main still
// names this decision. Readers and old-state recovery must select the prior
// immutable directory commit from first-parent history, not the mutable tip.
const historicalDirectory = await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']);
const historicalManifest = await manifest();
const laterMain = await git(canonical, ['commit-tree', await git(canonical, ['rev-parse', `${decision.mainSha}^{tree}`]), '-p', decision.mainSha], { input: 'Synthetic later publication target\n', env: fixedIdentity() });
await git(canonical, ['notes', '--ref=heddle-why', 'add', '-m', 'Synthetic later decision reason', laterMain], { env: fixedIdentity() });
const laterWhy = await git(canonical, ['rev-parse', 'refs/notes/heddle-why']);
const laterManifest = { ...historicalManifest, main: laterMain, expectedMain: decision.mainSha,
  inputHash: '9'.repeat(64), directoryBefore: historicalDirectory,
  refs: { ...historicalManifest.refs, 'refs/notes/heddle-why': { oid: laterWhy, before: historicalManifest.refs['refs/notes/heddle-why'].oid } } };
const directoryFiles = (await git(canonical, ['ls-tree', historicalDirectory])).split('\n').filter(row => !row.endsWith('\t.heddle-publication.json'));
const laterBlob = await git(canonical, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(laterManifest) + '\n' });
directoryFiles.push(`100644 blob ${laterBlob}\t.heddle-publication.json`);
const laterTree = await git(canonical, ['mktree'], { input: directoryFiles.join('\n') + '\n' });
const laterDirectory = await git(canonical, ['commit-tree', laterTree, '-p', historicalDirectory, '-p', laterMain, '-p', laterWhy], { input: 'Synthetic pending next directory\n', env: fixedIdentity() });
await git(canonical, ['update-ref', 'refs/heads/heddle/agents', laterDirectory, historicalDirectory]);
assert.equal(await main(), decision.mainSha);
assert.equal((await manifest()).main, laterMain, 'latest directory is explicitly ahead of landed main');
const beforeHistoricalRecovery = await refs();
await call('restore', baseline);
const oldRecovery = await call('publish', { ...pubRequest, opId: 'recover-behind-new-pending-directory' });
assert.equal(oldRecovery.main, decision.mainSha);
assert.equal(await refs(), beforeHistoricalRecovery, 'historical recovery must not roll back pending aliases');
const history = (await git(canonical, ['rev-list', '--first-parent', 'refs/heads/heddle/agents'])).split('\n');
const matchingSnapshots = [];
for (const sha of history) {
  const value = await run('git', ['--git-dir', canonical, 'show', `${sha}:.heddle-publication.json`], { allowFailure: true });
  if (value.code === 0 && JSON.parse(value.stdout).main === await main()) matchingSnapshots.push(sha);
}
assert.deepEqual(matchingSnapshots, [historicalDirectory]);
const { resolvePublication } = await import(pathToFileURL(join(dirname(engine), 'lib/publish.mjs')));
assert.deepEqual(await resolvePublication(laterDirectory, decision.mainSha, canonical), { oid: historicalDirectory, manifest: historicalManifest });
assert.equal((await resolvePublication(laterDirectory, laterMain, canonical)).oid, laterDirectory);
await expectFrozenWhy();
await pass('new pending directory and aliases cannot replace landed main historical snapshot or block lost-state recovery');

// Exercise a complete second native decision, not just a synthetic pending ref.
await reset();
await call('publish', pubRequest);
const firstDirectory = await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']);
const firstPublishedSnapshot = await call('snapshot', {});
await mutate('discuss', { task: 'first', author: 'decider', body: 'A later comment on the first landed task.' });
await mutate('task.create', { task: 'second', intent: 'Publish a second reviewed decision' });
const secondFork = join(root, 'fixture--second--picked.git'), secondCheckout = join(root, 'second-checkout');
await git(root, ['clone', '--bare', canonical, secondFork]);
await mutate('lane.open', { task: 'second', agent: 'picked' });
await git(root, ['clone', secondFork, secondCheckout]);
await writeFile(join(secondCheckout, 'README.md'), '# Second independently reviewed native decision\n');
await git(secondCheckout, ['add', '.']);
await git(secondCheckout, ['commit', '-m', 'Second exact candidate'], { env: fixedIdentity() });
await git(secondCheckout, ['push', 'origin', 'HEAD:main']);
const secondSource = await git(secondCheckout, ['rev-parse', 'HEAD']);
await mutate('ingest', { items: [{ task: 'second', agent: 'picked', fork: { remote: secondFork }, ref: 'refs/heads/main', sha: secondSource }], runTests: false });
const secondDecision = await mutate('decide', { task: 'second', pick: 'picked', decider: 'decider', rationale: 'Keep both historical decisions independently verifiable.', expectHeads: (await call('candidates', { task: 'second' })).heads });
const secondSnapshot = await call('snapshot', {});
await writeFile(hookPath, '#!/bin/sh\n[ "$1" != "refs/notes/heddle-why" ]\n', { mode: 0o700 });
const secondRequest = { ...pubRequest, opId: 'second-publication' };
assert.notEqual((await invoke('publish', secondRequest)).code, 0);
assert.equal(await main(), decision.mainSha);
const secondDirectory = await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']);
assert.equal((await manifest()).main, secondDecision.mainSha);
assert.equal((await resolvePublication(secondDirectory, decision.mainSha, canonical)).oid, firstDirectory);
await call('restore', firstPublishedSnapshot);
const pendingSecondRefs = await refs();
assert.equal((await call('publish', { ...pubRequest, opId: 'first-after-second-prepared' })).main, decision.mainSha);
assert.equal(await refs(), pendingSecondRefs);
await rm(hookPath);
await call('restore', secondSnapshot);
assert.equal((await call('publish', secondRequest)).main, secondDecision.mainSha);
assert.equal(await main(), secondDecision.mainSha);
await expectFrozenWhy();
assert.equal((await resolvePublication(secondDirectory, decision.mainSha, canonical)).oid, firstDirectory);
assert.equal((await resolvePublication(secondDirectory, secondDecision.mainSha, canonical)).oid, secondDirectory);
assert.equal((await call('why', { sha: secondDecision.mainSha })).narrative.includes(secondDecision.rationale), true);
await pass('two real native decisions retain first rationale and main-selected snapshots across interrupted second publish');

// Directory rejection cannot expose auxiliary refs, and a fresh engine process
// can recover its durable local checkpoint without restoring an older snapshot.
await reset();
const beforeDirectoryRejection = await refs();
await writeFile(hookPath, '#!/bin/sh\n[ "$1" != "refs/heads/heddle/agents" ]\n', { mode: 0o700 });
assert.notEqual((await invoke('publish', pubRequest)).code, 0);
assert.equal(await refs(), beforeDirectoryRejection);
assert.equal(JSON.parse(await readFile(join(state, 'engine.json'), 'utf8')).pendingPublication.main, decision.mainSha);
await rm(hookPath);
assert.equal((await call('publish', pubRequest)).main, decision.mainSha);
await expectFrozenWhy();
await pass('directory rejection leaves all refs unchanged; process restart resumes persisted checkpoint without restore');

// Corrupt frozen metadata without changing, and then with recomputing, its local
// checksum. An already-published same-main receipt must reject both variants.
await reset();
await call('publish', pubRequest);
const pristineState = await readFile(join(state, 'engine.json'), 'utf8');
const publishedRefsBeforeTamper = await refs();
const { requestHash } = await import(pathToFileURL(join(dirname(engine), 'lib/state.mjs')));
for (const rehash of [false, true]) {
  const changed = JSON.parse(pristineState);
  changed.publicationInput.input.agents.decider.displayName = 'Tampered publication identity';
  if (rehash) changed.publicationInput.hash = requestHash(changed.publicationInput.input);
  await writeFile(join(state, 'engine.json'), JSON.stringify(changed));
  const result = await invoke('publish', { ...pubRequest, opId: `tampered-frozen-input-${rehash}` });
  assert.equal(result.code, 2);
  assert.equal(result.data.error.code, rehash ? 'publication_conflict' : 'publication_input_drift');
  assert.equal(await refs(), publishedRefsBeforeTamper);
}
await writeFile(join(state, 'engine.json'), pristineState);
await pass('same-main frozen metadata tamper rejects with both stale and recomputed local hashes');

await reset();
const foreignCandidate = await git(canonical, ['commit-tree', await git(canonical, ['rev-parse', `${candidate}^{tree}`]), '-p', candidate], { input: 'Synthetic foreign candidate alias\n', env: fixedIdentity() });
await writeFile(hookPath, `#!/bin/sh
if [ "$1" = refs/notes/heddle-why ]; then
  git update-ref refs/heads/candidates/first/picked '${foreignCandidate}' '${candidate}' || exit 1
fi
`, { mode: 0o700 });
const changedDuringPrepare = await invoke('publish', pubRequest);
assert.equal(changedDuringPrepare.code, 2);
assert.equal(changedDuringPrepare.data.error.code, 'publication_conflict');
assert.equal(await main(), initial.mainSha);
const unboundAuxRefs = await refs();
await rm(hookPath);
await call('restore', baseline);
assert.equal((await invoke('publish', pubRequest)).code, 2);
assert.equal(await refs(), unboundAuxRefs);
await pass('auxiliary alias race before main is detected; restart refuses to repair foreign evidence');

await reset();
await call('publish', pubRequest);
const originalWhyRef = await git(canonical, ['rev-parse', 'refs/notes/heddle-why']);
const foreignWhyRef = await git(canonical, ['commit-tree', await git(canonical, ['rev-parse', `${originalWhyRef}^{tree}`]), '-p', originalWhyRef], { input: 'Synthetic foreign note alias\n', env: fixedIdentity() });
await git(canonical, ['update-ref', 'refs/notes/heddle-why', foreignWhyRef, originalWhyRef]);
const changedAfterLandingRefs = await refs();
await call('restore', baseline);
assert.equal((await invoke('publish', pubRequest)).code, 2);
assert.equal(await refs(), changedAfterLandingRefs);
assert.equal(await main(), decision.mainSha);
await pass('post-main alias tamper is detected without rewriting landed metadata');

// A later genuine decision must never overwrite an already-landed rationale.
await reset();
await call('publish', pubRequest);
await git(canonical, ['notes', '--ref=heddle-why', 'add', '-f', '-m', 'Synthetic historical rationale tamper', decision.mainSha], { env: fixedIdentity() });
const retconnedRefs = await refs();
await call('restore', secondSnapshot);
const retconAttempt = await invoke('publish', secondRequest);
assert.equal(retconAttempt.code, 2);
assert.equal(retconAttempt.data.error.code, 'publication_conflict');
assert.equal(await refs(), retconnedRefs);
assert.equal(await main(), decision.mainSha);
await pass('second native publication refuses conflicting preexisting rationale instead of retconning history');

// A coherent-reader helper must reject malformed manifests independently of
// publish's additional deterministic reconstruction checks.
await reset();
await call('publish', pubRequest);
const validDirectory = await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']);
const validManifest = await manifest();
const detachedCandidate = await git(canonical, ['commit-tree', await git(canonical, ['rev-parse', `${candidate}^{tree}`]), '-p', candidate], { input: 'Unretained synthetic proof\n', env: fixedIdentity() });
const badManifests = [
  ['array ref map', { ...validManifest, directoryBefore: validDirectory, refs: [] }],
  ['missing why ref', { ...validManifest, directoryBefore: validDirectory, refs: Object.fromEntries(Object.entries(validManifest.refs).filter(([ref]) => ref !== 'refs/notes/heddle-why')) }],
  ['false verify', { ...validManifest, directoryBefore: validDirectory, verify: { ...validManifest.verify, fsck: false } }],
  ['wrong predecessor', { ...validManifest, directoryBefore: initial.mainSha }],
  ['unretained proof', { ...validManifest, directoryBefore: validDirectory, refs: { ...validManifest.refs, 'refs/heads/candidates/first/picked': { oid: detachedCandidate, before: candidate } } }],
  ['duplicate same-main receipt', { ...validManifest, directoryBefore: validDirectory }],
];
for (const [label, bad] of badManifests) {
  const blob = await git(canonical, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(bad) + '\n' });
  const tree = await git(canonical, ['mktree'], { input: `100644 blob ${blob}\t.heddle-publication.json\n` });
  const commit = await git(canonical, ['commit-tree', tree, '-p', validDirectory], { input: `${label} fixture\n`, env: fixedIdentity() });
  await assert.rejects(() => resolvePublication(commit, decision.mainSha, canonical), { code: 'publication_conflict' }, label);
}
await pass('reader rejects array/missing refs, false verification, wrong lineage, unretained objects and duplicate main receipts');

console.log(JSON.stringify({ passed, fixtureRoot: root }, null, 2));
