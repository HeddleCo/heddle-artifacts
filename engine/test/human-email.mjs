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
const state = join(root, 'state'), seed = join(root, 'seed'), canonical = join(root, 'fixture.git');
// Engine subprocesses restrict inherited env; the wrapper isolates HOME for every native call.
const wrapper = join(root, 'heddle');
await writeFile(wrapper, '#!/bin/sh\nexport HOME="$HEDDLE_HOME"\nexec ' + "'" + binary.replaceAll("'", "'\\''") + "'" + ' "$@"\n', { mode: 0o700 });
const env = { ENGINE_STATE_DIR: state, HEDDLE_BIN: wrapper, TMPDIR: root, HOME: join(root, 'home') };
let operation = 0;
async function call(command, input = {}) {
  const result = await run(process.execPath, [engine, command], { input: JSON.stringify(input), env, allowFailure: true });
  assert.equal(result.code, 0, `${command}: ${result.stdout} ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const mutate = (command, input) => call(command, { opId: `email-${++operation}`, ...input });
const stored = async () => JSON.parse(await readFile(join(state, 'engine.json'), 'utf8'));
async function native(args, agent, cwd = join(state, 'repo')) {
  const home = join(state, 'agents', agent.id, 'home');
  const result = await run(binary, ['--output', 'json', ...args], { cwd,
    env: { ...actorEnv(agent), HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'config.toml') } });
  return JSON.parse(result.stdout);
}
try {
  console.log((await run(binary, ['--version'], { env: { HOME: join(root, 'home'), HEDDLE_HOME: join(root, 'home') } })).stdout.toString().trim());
  await mkdir(join(seed, 'src'), { recursive: true });
  await writeFile(join(seed, 'src/table.ts'), 'export function parseRow(row: string) { return row.split("|"); }\n');
  await git(seed, ['init', '-b', 'main']);
  await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-m', 'Seed']);
  await git(root, ['init', '--bare', '--initial-branch=main', canonical]);
  await mutate('init', { project: 'fixture', canonical: { remote: canonical }, seed: { importUrl: seed } });
  const human = { id: 'luke', kind: 'human', displayName: 'Luke', email: 'luke@heddle.sh' };
  const legacy = { id: 'legacy', kind: 'human', displayName: 'Legacy' };
  // Even if another caller enrolls an agent/reviewer with email metadata, their engine identity stays synthetic.
  const agent = { id: 'picked', kind: 'agent', displayName: 'Picked', email: 'ignored@example.com' };
  const reviewer = { id: 'reviewer', kind: 'reviewer', displayName: 'Reviewer', email: 'ignored@example.com' };
  for (const identity of [human, legacy, agent, reviewer]) await mutate('agent.enroll', { agent: identity });
  assert.equal(actorEnv(reviewer).HEDDLE_PRINCIPAL_EMAIL, 'reviewer@heddle-artifacts.local');
  for (const [task, decider, address] of [['real-email', human, human.email], ['legacy-email', legacy, 'legacy@heddle-artifacts.local']]) {
    await mutate('task.create', { task, intent: 'Change the parser' });
    const fork = join(root, `fixture--${task}--picked.git`), checkout = join(root, task);
    await git(root, ['clone', '--bare', canonical, fork]);
    await mutate('lane.open', { task, agent: agent.id });
    await git(root, ['clone', fork, checkout]);
    await writeFile(join(checkout, 'src/table.ts'), `export function parseRow(row: string) { return row.trim().split("|"); }\n// ${task}\n`);
    await git(checkout, ['add', '.']);
    await git(checkout, ['-c', 'user.name=Picked', '-c', 'user.email=source@example.invalid', 'commit', '-m', 'Change parser']);
    const sha = await git(checkout, ['rev-parse', 'HEAD']);
    await git(checkout, ['push', 'origin', 'HEAD:main']);
    await mutate('ingest', { items: [{ task, agent: agent.id, fork: { remote: fork }, ref: 'refs/heads/main', sha }], runTests: false });
    const candidates = await call('candidates', { task });
    const capture = await native(['show', candidates.candidates[0].state], agent);
    assert.equal(capture.principal.email, 'picked@heddle-artifacts.local', 'agent capture stays synthetic despite email metadata');
    console.log('PASS agent capture: Picked <picked@heddle-artifacts.local>');
    const rationale = `Decision by ${decider.displayName} uses the registered identity.`;
    const decision = await mutate('decide', { task, pick: agent.id, decider: decider.id, expectHeads: candidates.heads,
      rationale, anchor: 'src/table.ts:parseRow' });
    const expected = `${decider.displayName} <${address}>`;
    const identityFormat = '--format=%an <%ae>%n%cn <%ce>';
    assert.equal(await git(join(state, 'export.git'), ['show', '-s', identityFormat, decision.mainSha]), `${expected}\n${expected}`, 'landing author and committer use the human email');
    const context = await native(['context', 'get', '--path', 'src/table.ts', '--symbol', 'parseRow'], decider);
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
