// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, git } from '../lib/process.mjs';
import { fixedIdentity } from '../lib/git.mjs';

const engine = process.env.ENGINE_FILE || fileURLToPath(new URL('../engine.mjs', import.meta.url));
const requested = process.argv[2];
for (const advancing of requested ? [requested] : ['decided', 'unrelated']) {
  assert(['decided', 'unrelated'].includes(advancing));
  const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'track-b-publication-race-'));
  const state = join(root, 'state'), canonical = join(root, 'fixture.git');
  const env = { ENGINE_STATE_DIR: state, HEDDLE_BIN: process.env.HEDDLE_BIN || 'heddle', TMPDIR: process.env.TMPDIR || '/tmp' };
  const call = async (cmd, body, expected = 0) => {
    const result = await run(process.execPath, [engine, cmd], {
      env, input: Buffer.isBuffer(body) ? body : JSON.stringify(body), allowFailure: true,
    });
    assert.equal(result.code, expected, `${advancing} ${cmd}: ${result.stdout} ${result.stderr}`);
    return cmd === 'snapshot' ? result.stdout : JSON.parse(result.stdout);
  };
  const seed = join(root, 'seed'); await mkdir(seed);
  await git(seed, ['init', '-b', 'main']);
  await writeFile(join(seed, 'README.md'), '# Public synthetic publication race\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'Synthetic seed'], { env: fixedIdentity() });
  await git(root, ['init', '--bare', '--initial-branch=main', canonical]);
  await call('init', { opId: 'init', project: 'fixture', canonical: { remote: canonical }, seed: { importUrl: seed } });
  for (const task of ['decided', 'unrelated']) await call('task.create', { opId: `task-${task}`, task, intent: `Exercise ${task} lane publication race` });
  for (const [id, kind] of [['fixture-picked', 'agent'], ['fixture-other', 'agent'], ['fixture-decider', 'human']]) {
    await call('agent.enroll', { opId: `enroll-${id}`, agent: { id, kind, displayName: id } });
  }
  const lanes = [];
  for (const [task, agent] of [['decided', 'fixture-picked'], ['unrelated', 'fixture-other']]) {
    const fork = join(root, `fixture--${task}--${agent}.git`), checkout = join(root, `${task}-checkout`);
    await git(root, ['clone', '--bare', canonical, fork]);
    await call('lane.open', { opId: `lane-${task}`, task, agent });
    await git(root, ['clone', fork, checkout]);
    await writeFile(join(checkout, 'README.md'), `# Reviewed ${task} candidate\n`);
    await git(checkout, ['add', '.']);
    await git(checkout, ['commit', '-m', `Reviewed ${task} candidate`], { env: fixedIdentity() });
    await git(checkout, ['push', 'origin', 'HEAD:main']);
    const sha = await git(checkout, ['rev-parse', 'HEAD']);
    lanes.push({ task, agent, fork: { remote: fork }, ref: 'refs/heads/main', sha, checkout });
  }
  const item = ({ checkout, ...input }) => input;
  await call('ingest', { opId: 'ingest', items: lanes.map(item), runTests: false });
  const before = await call('candidates', { task: 'decided' });
  const decision = await call('decide', { opId: 'decision', task: 'decided', pick: 'fixture-picked', decider: 'fixture-decider', rationale: 'Publish the exact reviewed candidate', expectHeads: before.heads });
  const signedState = JSON.parse(await readFile(join(state, 'engine.json')));
  const snapshot = await call('snapshot', {});

  // Fork transport can still accept a push before revocation, or on another open task.
  const changed = lanes.find(lane => lane.task === advancing);
  await writeFile(join(changed.checkout, 'README.md'), `# Unreviewed later ${advancing} push\n`);
  await git(changed.checkout, ['add', '.']);
  await git(changed.checkout, ['commit', '-m', 'Unreviewed later push'], { env: fixedIdentity() });
  await git(changed.checkout, ['push', 'origin', 'HEAD:main']);
  const laterSha = await git(changed.checkout, ['rev-parse', 'HEAD']);
  assert.notEqual(laterSha, changed.sha);

  const request = { opId: 'publication', canonical: { remote: canonical } };
  const published = await call('publish', request);
  assert.equal(published.main, decision.mainSha, 'later pushes cannot change or block the signed landing');
  assert.deepEqual(published.verify, { exportRoundTrip: true, treeMatch: true, fsck: true });
  for (const lane of lanes) assert.equal(await git(canonical, ['rev-parse', `refs/heads/candidates/${lane.task}/${lane.agent}`]), lane.sha, 'publish only the already-ingested original candidate');
  assert.equal(await git(canonical, ['rev-parse', 'main^{tree}']), await git(canonical, ['rev-parse', `${lanes[0].sha}^{tree}`]));
  assert.deepEqual(await call('candidates', { task: 'decided' }), before);
  const after = JSON.parse(await readFile(join(state, 'engine.json')));
  assert.deepEqual(after.decisions, signedState.decisions, 'publication does not rewrite signed decisions');
  assert.deepEqual(after.attestations, signedState.attestations, 'publication preserves exact signed proofs');
  assert.equal(after.lanes['unrelated/fixture-other'].status, 'active');

  // A lost post-push journal generation must recover even while the external tip differs.
  await call('restore', snapshot);
  assert.equal((await call('publish', request)).main, decision.mainSha);
  if (advancing === 'decided') {
    const late = await call('ingest', { opId: 'late-ingest', items: [{ ...item(changed), sha: laterSha }], runTests: false });
    assert.equal(late.results[0].status, 'rejected');
    assert.equal(late.results[0].reason, 'lane_released', 'post-close push is never admitted');
  }
  const exportRoot = join(state, 'export.git');
  await git(exportRoot, ['fetch', '--no-tags', '--no-write-fetch-head', changed.fork.remote, laterSha]);
  await git(exportRoot, ['update-ref', `refs/heads/candidates/${changed.task}/${changed.agent}`, laterSha]);
  const refsBeforeTamper = await git(canonical, ['show-ref']);
  const tampered = await call('publish', { ...request, opId: 'tampered-publication' }, 2);
  assert.equal(tampered.error.code, 'candidate_drift', 'local candidate ref tampering still fails closed');
  assert.equal(await git(canonical, ['show-ref']), refsBeforeTamper);
  console.log(`Publication race PASS: ${advancing} fork advancement cannot block signed closure or restored replay; original candidate refs and tamper guard preserved`);
}
