// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, git } from '../lib/process.mjs';
import { fixedIdentity } from '../lib/git.mjs';

const engine = process.env.ENGINE_FILE || fileURLToPath(new URL('../engine.mjs', import.meta.url));
const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'track-b-hardening-'));
const state = join(root, 'state'), canonical = join(root, 'fixture-project.git');
const selected = process.argv[2] || 'all';
const env = { ENGINE_STATE_DIR: state, HEDDLE_BIN: process.env.HEDDLE_BIN || 'heddle', TMPDIR: process.env.TMPDIR || '/tmp' };
const call = async (cmd, body, expected = 0, engineFile = engine) => {
  const result = await run(process.execPath, [engineFile, cmd], {
    env, input: Buffer.isBuffer(body) ? body : JSON.stringify(body), allowFailure: true,
  });
  assert.equal(result.code, expected, `${cmd}: ${result.stdout} ${result.stderr}`);
  return cmd === 'snapshot' ? result.stdout : JSON.parse(result.stdout);
};

if (selected === 'all' || selected === 'fork') {
  const { forkRemote } = await import(pathToFileURL(join(dirname(engine), 'lib/git.mjs')));
  const project = 'p'.repeat(63), task = 'fixture-task', agent = 'fixture-agent';
  const full = `${project}--${task}--${agent}`;
  // Match Track A's WebCrypto SHA-256 contract, including its exact prefix length.
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(full))).toString('hex');
  const expected = `${full.slice(0, 46)}-${digest.slice(0, 16)}`;
  assert.equal(forkRemote('https://example.invalid/namespace/p.git', project, task, agent), `https://example.invalid/namespace/${expected}.git`, 'long fork must match Track A');
  assert.equal(forkRemote('/tmp/p', 'p', 't', 'a'), '/tmp/p--t--a');
  assert.equal(forkRemote('/tmp/p.git', 'p', 't', 'a'), '/tmp/p--t--a.git');
  assert.equal(forkRemote('/tmp/p', 'p'.repeat(57), 't', 'a'), `/tmp/${'p'.repeat(57)}--t--a`);
  assert.equal(forkRemote('/tmp/p', 'p'.repeat(58), 't', 'a').slice(5).length, 63);
  console.log('Fork naming PASS: Track A SHA-256 truncation, 63-character boundary, suffix and short names agree');
}

if (selected === 'all' || selected === 'replay') {
  // Enrollment needs only a manifest; these synthetic custodial keys stay in private scratch.
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, 'engine.json'), JSON.stringify({ format: 1, generation: 0, project: 'fixture-project', root: state, turns: [] }));
  const request = { opId: 'fixture-replay', agent: { id: 'fixture-actor', kind: 'agent', displayName: 'Fixture actor' } };
  const original = await call('agent.enroll', request);
  const before = await readFile(join(state, 'engine.json'));
  const reordered = { agent: { displayName: 'Fixture actor', kind: 'agent', id: 'fixture-actor' }, opId: request.opId };
  assert.deepEqual(await call('agent.enroll', reordered), original, 'object key order does not affect replay');
  assert.deepEqual(await readFile(join(state, 'engine.json')), before, 'matching replay does not mutate manifest');
  const changed = { ...request, agent: { ...request.agent, id: 'fixture-other' } };
  const mismatch = await run(process.execPath, [engine, 'agent.enroll'], { env, input: JSON.stringify(changed), allowFailure: true });
  console.log(`Changed-input replay observed exit ${mismatch.code}; expected domain rejection 2`);
  assert.equal(mismatch.code, 2, 'same opId must not replay an unrelated request');
  assert.equal(JSON.parse(mismatch.stdout).error.code, 'op_id_conflict');
  assert.deepEqual(await readFile(join(state, 'engine.json')), before, 'conflicting replay does not mutate manifest');
  const legacy = JSON.parse(before); delete legacy.operations[request.opId].requestHash;
  await writeFile(join(state, 'engine.json'), JSON.stringify(legacy));
  const unbound = await call('agent.enroll', request, 2);
  assert.equal(unbound.error.code, 'op_id_conflict', 'unbound legacy replay fails closed');
  await rm(state, { recursive: true, force: true });
  console.log('Replay binding PASS: reordered equivalent input replays; changed or unbound input is rejected without mutation');
}

if (selected === 'all' || selected === 'publish') {
  const seed = join(root, 'seed');
  await mkdir(seed);
  await git(seed, ['init', '-b', 'main']);
  await writeFile(join(seed, 'README.md'), '# Public synthetic publication fixture\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'Synthetic seed'], { env: fixedIdentity() });
  await git(root, ['init', '--bare', '--template=', '--initial-branch=main', canonical]);
  // The minimal runtime has no Git templates; fixtures own their hook directory.
  await assert.rejects(stat(join(canonical, 'hooks')), { code: 'ENOENT' });
  await mkdir(join(canonical, 'hooks'));
  await call('init', { opId: 'fixture-init', project: 'fixture-project', canonical: { remote: canonical }, seed: { importUrl: seed } });
  await call('task.create', { opId: 'fixture-task', task: 'fixture-task', intent: 'Exercise local publication recovery' });
  for (const [id, kind] of [['fixture-actor', 'agent'], ['fixture-decider', 'human']]) {
    await call('agent.enroll', { opId: `enroll-${id}`, agent: { id, kind, displayName: id } });
  }
  const fork = join(root, 'fixture-project--fixture-task--fixture-actor.git');
  await git(root, ['clone', '--bare', canonical, fork]);
  await call('lane.open', { opId: 'fixture-lane', task: 'fixture-task', agent: 'fixture-actor' });
  const checkout = join(root, 'checkout');
  await git(root, ['clone', fork, checkout]);
  await writeFile(join(checkout, 'README.md'), '# Public synthetic selected candidate\n');
  await git(checkout, ['add', '.']);
  await git(checkout, ['commit', '-m', 'Synthetic candidate'], { env: fixedIdentity() });
  await git(checkout, ['push', 'origin', 'HEAD:main']);
  const sha = await git(checkout, ['rev-parse', 'HEAD']);
  await call('ingest', { opId: 'fixture-ingest', items: [{ task: 'fixture-task', agent: 'fixture-actor', fork: { remote: fork }, ref: 'refs/heads/main', sha }], runTests: false });
  const heads = (await call('candidates', { task: 'fixture-task' })).heads;
  const decision = await call('decide', { opId: 'fixture-decision', task: 'fixture-task', pick: 'fixture-actor', decider: 'fixture-decider', rationale: 'Exercise local publication recovery', expectHeads: heads });
  const snapshot = await call('snapshot', {});
  const refsBefore = await git(canonical, ['show-ref']);
  const mainBefore = await git(canonical, ['rev-parse', 'main']);
  await git(canonical, ['config', 'receive.advertiseAtomic', 'false']);
  const hook = join(canonical, 'hooks/update');
  await writeFile(hook, '#!/bin/sh\n[ "$1" != "refs/notes/heddle-why" ]\n', { mode: 0o700 });
  const request = { opId: 'fixture-publish', canonical: { remote: canonical } };
  await call('publish', request, 1);
  const refsAfter = await git(canonical, ['show-ref']);
  assert.notEqual(refsAfter, refsBefore, 'auxiliary refs honestly remain staged while publication is pending');
  assert.equal(await git(canonical, ['rev-parse', 'main']), mainBefore, 'a rejected proof ref must never advance main');
  const pendingDirectory = await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']);
  const pending = JSON.parse(await git(canonical, ['show', `${pendingDirectory}:.heddle-publication.json`]));
  assert.equal(pending.main, decision.mainSha, 'pending immutable receipt pins the decision');
  assert.equal(pending.expectedMain, mainBefore);
  const changedOp = await call('publish', { ...request, canonical: { remote: canonical + '-changed' } }, 2);
  assert.equal(changedOp.error.code, 'op_id_conflict', 'an interrupted opId remains canonically bound');
  const fenced = await call('discuss', { opId: 'pending-discuss', task: 'fixture-task', author: 'fixture-decider', body: 'Do not change the pending snapshot' }, 2);
  assert.equal(fenced.error.code, 'publication_pending');
  await rm(hook);
  await call('restore', snapshot);

  // Model a container disappearing after Git acknowledged all refs, before the journal commit.
  const crashEngine = join(root, 'crash-engine');
  await cp(dirname(engine), crashEngine, { recursive: true });
  const crashFile = join(crashEngine, 'engine.mjs');
  const source = await readFile(crashFile, 'utf8');
  const marker = '          await save(state,';
  assert(source.includes(marker));
  await writeFile(crashFile, source.replace(marker, "          if (cmd === 'publish') process.exit(86);\n" + marker));
  const interrupted = await run(process.execPath, [crashFile, 'publish'], { env, input: JSON.stringify(request), allowFailure: true });
  assert.equal(interrupted.code, 86, 'interrupt occurs after acknowledged push and before save');
  assert.equal(await git(canonical, ['rev-parse', 'main']), decision.mainSha);
  assert.equal(await git(canonical, ['rev-parse', 'refs/heads/heddle/agents']), pendingDirectory, 'retry reuses the exact pending directory snapshot');
  const prior = JSON.parse(await readFile(join(state, 'engine.json')));
  assert.equal(prior.operations[request.opId], undefined, 'interrupted result was not committed');
  await call('restore', snapshot);
  const retried = await call('publish', request);
  assert.equal(retried.main, decision.mainSha, 'snapshot replay keeps the fixed landing SHA');
  assert.deepEqual(retried.verify, { exportRoundTrip: true, treeMatch: true, fsck: true });
  const remoteAfterRetry = await git(canonical, ['show-ref']);
  assert.deepEqual(await call('publish', request), retried);
  assert.equal(await git(canonical, ['show-ref']), remoteAfterRetry, 'committed replay does not republish notes');
  await git(canonical, ['fsck', '--strict']);
  console.log('Publication recovery PASS: proof rejection leaves only pending auxiliary refs and unchanged main; atomic-disabled server succeeds; interrupted opIds remain bound; post-push interruption restores the exact main and immutable receipt');
}
if (selected === 'all' || selected === 'publication-races') {
  const raced = await run(process.execPath, [fileURLToPath(new URL('./publication-races.mjs', import.meta.url))], {
    env: { ...env, ENGINE_FILE: engine }, timeout: 180000,
  });
  process.stdout.write(raced.stdout);
}
console.log(`Hardening fixture completed: ${selected}`);
