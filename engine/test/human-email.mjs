// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, git } from '../lib/process.mjs';
import { actorEnv } from '../lib/state.mjs';
import { verifyAttestation } from '../lib/attestations.mjs';
import { decodeMsgpack } from '../lib/signatures.mjs';

const root = await mkdtemp(join(tmpdir(), 'human-email-'));
const binary = process.env.HEDDLE_BIN || 'heddle';
const engine = fileURLToPath(new URL('../engine.mjs', import.meta.url));
const seed = join(root, 'seed');
let state, canonical;
// Engine subprocesses restrict inherited env; the wrapper isolates HOME for every native call.
const wrapper = join(root, 'heddle');
await writeFile(wrapper, '#!/bin/sh\nexport HOME="$HEDDLE_HOME"\nexec ' + "'" + binary.replaceAll("'", "'\\''") + "'" + ' "$@"\n', { mode: 0o700 });
const env = { HEDDLE_BIN: wrapper, TMPDIR: root, HOME: join(root, 'home'), ACTOR_EMAIL_DOMAIN: 'noreply.heddle.sh' };
let operation = 0;
async function raw(command, input = {}) {
  return run(process.execPath, [engine, command], { input: Buffer.isBuffer(input) ? input : JSON.stringify(input),
    env: { ...env, ENGINE_STATE_DIR: state }, allowFailure: true, maxBytes: 64 * 1024 * 1024 });
}
async function call(command, input = {}) {
  const result = await raw(command, input);
  assert.equal(result.code, 0, `${command}: ${result.stdout} ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const mutate = (command, input) => call(command, { opId: `email-${++operation}`, ...input });
const stored = async () => JSON.parse(await readFile(join(state, 'engine.json'), 'utf8'));
async function native(args, id, cwd = join(state, 'repo')) {
  const agent = (await stored()).agents[id], home = join(state, 'agents', id, 'home');
  const result = await run(binary, ['--output', 'json', ...args], { cwd,
    env: { ...actorEnv(agent), HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'config.toml') } });
  return JSON.parse(result.stdout);
}
async function project(id) {
  state = join(root, `${id}-state`); canonical = join(root, `${id}.git`);
  await git(root, ['init', '--bare', '--initial-branch=main', canonical]);
  await mutate('init', { project: id, canonical: { remote: canonical }, seed: { importUrl: seed } });
}
async function candidate(task, agent, address) {
  await mutate('task.create', { task, intent: 'Change the parser' });
  const fork = join(root, `${(await stored()).project}--${task}--${agent.id}.git`), checkout = join(root, task);
  await git(root, ['clone', '--bare', canonical, fork]);
  await mutate('lane.open', { task, agent: agent.id });
  await git(root, ['clone', fork, checkout]);
  await writeFile(join(checkout, 'src/table.ts'), `export function parseRow(row: string) { return row.trim().split("|"); }\n// ${task}\n`);
  await git(checkout, ['add', '.']);
  await git(checkout, ['-c', `user.name=${agent.displayName}`, '-c', 'user.email=source@example.invalid', 'commit', '-m', 'Change parser']);
  const sha = await git(checkout, ['rev-parse', 'HEAD']);
  await git(checkout, ['push', 'origin', 'HEAD:main']);
  const ingested = await mutate('ingest', { items: [{ task, agent: agent.id, fork: { remote: fork }, ref: 'refs/heads/main', sha }], runTests: false });
  assert.equal(ingested.results[0].status, 'captured', JSON.stringify(ingested.results));
  const candidates = await call('candidates', { task });
  const capture = await native(['show', candidates.candidates[0].state], agent.id);
  assert.equal(capture.principal.email, address, 'agent capture uses the address fixed at enrollment');
  console.log(`PASS ${task} agent capture: ${agent.displayName} <${capture.principal.email}>`);
  return candidates;
}
try {
  console.log((await run(binary, ['--version'], { env: { HOME: join(root, 'home'), HEDDLE_HOME: join(root, 'home') } })).stdout.toString().trim());
  await mkdir(join(seed, 'src'), { recursive: true });
  await writeFile(join(seed, 'src/table.ts'), 'export function parseRow(row: string) { return row.split("|"); }\n');
  await git(seed, ['init', '-b', 'main']);
  await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-m', 'Seed']);
  const human = { id: 'luke', kind: 'human', displayName: 'Luke', email: 'luke@heddle.sh', sponsor: true };
  // Nonhuman email metadata never selects the identity address.
  const agent = { id: 'gwen', kind: 'agent', displayName: 'Gwen', email: 'ignored@example.com' };
  await project('unsponsored');
  await mutate('agent.enroll', { agent: { id: 'other', kind: 'human', displayName: 'Other', email: 'other@example.com' } });
  await mutate('agent.enroll', { agent });
  await candidate('no-sponsor', agent, 'gwen@noreply.heddle.sh');
  await mutate('agent.enroll', { agent: human });
  await mutate('agent.enroll', { agent });
  await candidate('before-sponsor', agent, 'gwen@noreply.heddle.sh');
  console.log('PASS enrollment before sponsor remains noreply after sponsor registration and re-enrollment');

  await project('sponsored');
  const legacy = { id: 'legacy', kind: 'human', displayName: 'Legacy' };
  const oldAgent = { id: 'old', kind: 'agent', displayName: 'Old', email: 'ignored@example.com' };
  const reviewer = { id: 'reviewer', kind: 'reviewer', displayName: 'Reviewer', email: 'ignored@example.com' };
  for (const identity of [human, agent, legacy, oldAgent, reviewer]) await mutate('agent.enroll', { agent: identity });
  for (const [task, picked, decider, address, captureAddress] of [
    ['real-email', agent, human, human.email, 'luke+gwen@heddle.sh'],
    ['legacy-email', oldAgent, legacy, 'legacy@heddle-artifacts.local', 'old@heddle-artifacts.local']
  ]) {
    if (task === 'legacy-email') {
      // A real snapshot/restore of old-format records: no address backfill, even
      // with a sponsor present and a different deployment default after restore.
      const original = await stored();
      delete original.agents.legacy.address; delete original.agents.old.address;
      await writeFile(join(state, 'engine.json'), JSON.stringify(original) + '\n');
      const archive = await raw('snapshot'); assert.equal(archive.code, 0, archive.stderr.toString());
      state = join(root, 'restored-state'); env.ACTOR_EMAIL_DOMAIN = 'noreply.operator.example';
      await call('restore', archive.stdout);
      const restored = await stored();
      assert.deepEqual(restored.agents, original.agents, 'restore preserves identity records exactly');
      assert.equal(restored.agents.luke.sponsor, true, 'restore preserves the explicit sponsor');
      assert.equal(restored.agents.gwen.address, 'luke+gwen@heddle.sh', 'restore preserves newly stored addresses too');
      assert.equal(actorEnv(restored.agents.old).HEDDLE_PRINCIPAL_EMAIL, 'old@heddle-artifacts.local');
      console.log('PASS older snapshot restored without address migration; sponsor and frozen addresses retained');
    }
    const candidates = await candidate(task, picked, captureAddress);
    if (task === 'real-email') {
      const snapshot = await stored();
      assert.equal(snapshot.agents.reviewer.address, 'luke+reviewer@heddle.sh');
      assert.equal(actorEnv(snapshot.agents.reviewer).HEDDLE_PRINCIPAL_EMAIL, 'luke+reviewer@heddle.sh');
      console.log('PASS reviewer: Reviewer <luke+reviewer@heddle.sh>');
    }
    const rationale = `Decision by ${decider.displayName} uses the registered identity.`;
    const decision = await mutate('decide', { task, pick: picked.id, decider: decider.id, expectHeads: candidates.heads,
      rationale, anchor: 'src/table.ts:parseRow' });
    const expected = `${decider.displayName} <${address}>`;
    const identityFormat = '--format=%an <%ae>%n%cn <%ce>';
    assert.equal(await git(join(state, 'export.git'), ['show', '-s', identityFormat, decision.mainSha]), `${expected}\n${expected}`, 'landing author and committer use the human email');
    const context = await native(['context', 'get', '--path', 'src/table.ts', '--symbol', 'parseRow'], decider.id);
    const annotation = context.annotations.find(a => a.content === rationale);
    assert.ok(annotation, 'native rationale annotation exists');
    assert.equal(annotation.attribution, expected, 'native annotation uses the human email');
    console.log(`PASS native annotation: ${annotation.attribution}`);
    const snapshot = await stored();
    const attestation = snapshot.attestations[snapshot.decisionAttestations[task]];
    assert.equal(verifyAttestation(attestation, snapshot.agents[decider.id].publicKey), snapshot.agents[decider.id].publicKey);
    const envelope = decodeMsgpack(Buffer.from(JSON.parse(attestation.payload).nativeEnvelope, 'base64'));
    assert.equal(envelope.author.principal.email.toString(), address, 'signed decision envelope uses the human email');
    assert.equal(envelope.author.principal.name.toString(), decider.displayName);
    assert.equal(snapshot.agents[decider.id].email, decider.email, 'enrollment preserves optional human email');
    console.log(`PASS signed decision envelope: ${expected} (signature verified)`);
    await mutate('publish', { canonical: { remote: canonical } });
    assert.equal(await git(canonical, ['show', '-s', identityFormat, 'main']), `${expected}\n${expected}`, 'publication retains landing identity');
    console.log(`PASS ${task}: landing and published author/committer ${expected}`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
