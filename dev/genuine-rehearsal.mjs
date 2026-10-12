// SPDX-License-Identifier: Apache-2.0
// Local orchestration only. Uses the existing Worker, engine and stock Heddle.
// Agents edit separate enrolled Git forks. An operator reviews all tree bytes
// and writes an out-of-band manifest plus approval before any push/ingestion.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { startFakeArtifacts } from './fake-artifacts/server.mjs';
import { startEngineDevserver } from './engine-devserver.mjs';
import { command, joinProject, request, gitAuth } from '../cli/ha.mjs';

const root = resolve(process.env.GENUINE_RUN_DIR || '../genuine-v1');
const replaySource = process.env.GENUINE_REPLAY_SOURCE ? resolve(process.env.GENUINE_REPLAY_SOURCE) : undefined;
const evidence = join(root, 'evidence'), privateDir = join(root, 'private');
const manifest = resolve(process.env.HEDDLE_TRUSTED_TEST_MANIFEST || '../operator-reviewed/genuine-v1.json');
assert.ok(!manifest.startsWith(root + '/'), 'The operator manifest must remain outside run/candidate/state directories');
process.env.HEDDLE_TRUSTED_TEST_MANIFEST = manifest;
const agents = ['native-scan', 'native-parity'];
const task = 'parser-escapes';
const identity = { provider: 'openai-native-collaboration', model: 'runtime-selected-not-exposed' };
const start = Date.now(), timeline = [];
const mark = (stage, data = {}) => { timeline.push({ stage, at: new Date().toISOString(), elapsedMs: Date.now() - start, ...data }); console.log(`GENUINE ${stage}`); };
await mkdir(evidence, { recursive: true, mode: 0o700 });
await mkdir(privateDir, { recursive: true, mode: 0o700 });
await access(manifest);
const project = `genuine-${randomBytes(4).toString('hex')}`, token = randomBytes(32).toString('hex');
const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port; await new Promise(r => listener.close(r));
const origin = `http://127.0.0.1:${port}`, api = `${origin}/api/projects/${project}`;
let fake, engine, wrangler, stage = 'startup';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 3600000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(250); }
  throw new Error('Rehearsal phase deadline exceeded');
}
async function file(name) { try { return JSON.parse(await readFile(join(root, name), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
async function save(name, data) { await writeFile(join(evidence, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); }
try {
  fake = await startFakeArtifacts({ root: join(privateDir, 'artifacts'), port: 0, eventUrl: `${origin}/__dev/events` });
  engine = await startEngineDevserver({ root: join(privateDir, 'engine'), port: 0 });
  const config = JSON.parse((await readFile('wrangler.dev.jsonc', 'utf8')).replace(/^\/\/.*$/gm, ''));
  config.main = resolve('dev/test-worker.ts');
  config.alias = { 'heddle-reviewer': resolve('dev/genuine-reviewer.ts') };
  config.assets.directory = resolve('ui/dist');
  config.$schema = resolve('node_modules/wrangler/config-schema.json');
  const configFile = join(privateDir, 'wrangler.json');
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  wrangler = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', configFile, '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', join(privateDir, 'wrangler'), '--var', `OPERATOR_TOKEN:${token}`, '--var', `DEMO_PROJECT:${project}`, '--var', `FAKE_ARTIFACTS_URL:${fake.origin}`, '--var', `ENGINE_DEV_URL:${engine.origin}`], {
    detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(privateDir, 'wrangler.log') }, stdio: ['ignore', 'pipe', 'pipe']
  });
  // Binding output includes local credentials: never forward it to evidence.
  wrangler.stdout.resume(); wrangler.stderr.resume();
  await waitFor(async () => { try { return (await fetch(`${origin}/login`)).ok; } catch { return false; } }, 30000);
  const initialized = await request(`${origin}/api/projects`, token, { id: project, seed: { template: 'demo' } });
  await request(`${api}/tasks`, token, { slug: task, intent: 'Implement escaped pipe and backslash parity support in parseRow, preserving string[] and baseline behavior. Two independent native coding agents propose competing implementations.' });
  await request(`${api}/humans`, token, { id: 'scripted-test-choice', displayName: 'Scripted test choice (not a real human decision)' });
  const clones = {};
  for (const agent of agents) {
    const result = await joinProject(`${origin}/p/${project}`, { task, as: agent, directory: join(root, 'forks', agent), token, ...identity });
    clones[agent] = result.cwd;
  }
  const baseSha = await command('git', ['rev-parse', 'HEAD'], { cwd: clones[agents[0]] });
  mark('forks-ready');
  await save('ready.json', { origin, project, task, baseSha, clones, identity, startedAt: new Date(start).toISOString(), ...(replaySource ? { runKind: 'historical-candidate-decision-replay', replaySource, freshCodingTasks: false, freshReviewerTask: false } : {}) });

  stage = 'operator-review';
  const approval = await waitFor(() => file('operator-approval.json'));
  assert.equal(approval.reviewedCompleteTrees, true);
  assert.equal(approval.manifestSha256, createHash('sha256').update(await readFile(manifest)).digest('hex'));
  const pushed = {};
  for (const agent of agents) {
    pushed[agent] = await command('git', ['rev-parse', 'HEAD'], { cwd: clones[agent] });
    assert.equal(pushed[agent], approval.candidates[agent].sourceSha);
    assert.equal(await command('git', ['status', '--porcelain'], { cwd: clones[agent] }), '');
    assert.ok(pushed[agent] !== baseSha);
  }
  await save('operator-approval.json', approval);
  mark('complete-trees-approved');
  stage = 'push-and-ingest';
  await Promise.all(agents.map(agent => command('git', ['push', 'origin', 'HEAD:main'], { cwd: clones[agent] })));
  mark('concurrent-git-pushes-complete', { pushed });
  const view = await waitFor(async () => {
    const data = await request(`${api}/tasks/${task}`, token);
    return data.candidates.length === agents.length && data.candidates.every(c => c.tests) ? data : undefined;
  }, 180000);
  const board = await request(api, token);
  for (const c of view.candidates) {
    assert.equal(c.sourceSha, pushed[c.agent]);
    assert.equal(c.signedBy, board.agents.find(a => a.id === c.agent).publicKey);
    assert.equal(c.tests.status, 'pass', `${c.agent} tests`);
    assert.ok(c.conflicts.some(x => x.path === 'src/table.ts' && x.with.includes(agents.find(a => a !== c.agent))));
    const response = await fetch(`${api}/tasks/${task}/candidates/${c.agent}/diff`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    await writeFile(join(evidence, `${c.agent}.diff`), await response.text(), { mode: 0o600 });
  }
  await save('candidate-view.json', view);
  await save('public-identities.json', board.agents);
  mark('signed-tested-conflicting-candidates-ready');
  await save('review-input.json', { task: view.task, candidates: view.candidates, heads: view.heads, pushed, clones });

  stage = 'independent-review';
  const reviewed = await waitFor(() => file('native-review.json'));
  assert.equal(reviewed.provider, identity.provider);
  assert.equal(reviewed.model, identity.model);
  assert.ok(typeof reviewed.taskIdentity === 'string' && reviewed.taskIdentity.includes('review'));
  assert.ok(agents.includes(reviewed.recommendation.pick));
  assert.deepEqual(reviewed.sourceShas, pushed);
  if (replaySource) {
    const originalReview = JSON.parse(await readFile(join(replaySource, 'native-review.json'), 'utf8'));
    assert.deepEqual(reviewed, originalReview, 'Replay preserves the exact historical native reviewer body');
    const context = await request(`${api}/tasks/${task}/turns`, token, { as: 'scripted-test-choice', body: `HISTORICAL REVIEW REPLAY: these are the exact original genuine agent commits and prior reviewer text. No new coding session or reviewer model invocation occurred. This fresh local decision tests timestamp correctness and stable export. Source landing: ${JSON.parse(await readFile(join(replaySource, 'result.json'), 'utf8')).main}` });
    await save('replay-context-turn.json', context);
  }
  const enrollment = await request(`${api}/tasks/${task}/agents`, token, { id: 'native-reviewer', kind: 'reviewer', displayName: replaySource ? 'Historical native reviewer text (replay)' : 'Independent native collaboration reviewer', ...identity });
  const turn = await request(`${api}/tasks/${task}/turns`, enrollment.agentKey, { body: JSON.stringify(reviewed) });
  assert.equal(turn.author, 'native-reviewer'); assert.equal(turn.kind, 'reviewer');
  assert.ok(turn.signedBy && turn.heddleDiscussion);
  await save('native-review.json', reviewed); await save('review-turn.json', turn);
  mark('genuine-review-signed', { discussion: turn.heddleDiscussion });

  stage = 'scripted-test-choice';
  const rationale = `SCRIPTED TEST CHOICE, not a human product decision. ${replaySource ? 'HISTORICAL REVIEW REPLAY, without new coding/reviewer sessions. Follow the prior' : 'Follow the independent'} native reviewer recommendation: ${reviewed.recommendation.why}`;
  const reply = await request(`${api}/tasks/${task}/turns`, token, { as: 'scripted-test-choice', body: rationale });
  const current = await request(`${api}/tasks/${task}`, token);
  assert.deepEqual(current.heads, view.heads);
  const decision = await request(`${api}/tasks/${task}/decision`, token, { pick: reviewed.recommendation.pick, decider: 'scripted-test-choice', rationale, expectHeads: current.heads });
  const proof = join(privateDir, 'proof');
  const env = gitAuth([[initialized.canonicalRemote, initialized.readToken]]);
  await command('git', ['clone', '--quiet', initialized.canonicalRemote, proof], { env });
  await command('git', ['fetch', '--quiet', 'origin', '+refs/notes/*:refs/notes/*'], { cwd: proof, env });
  const main = await command('git', ['rev-parse', 'HEAD'], { cwd: proof });
  assert.equal(main, decision.mainSha);
  for (const agent of agents) assert.equal(await command('git', ['rev-parse', `origin/candidates/${task}/${agent}`], { cwd: proof }), pushed[agent]);
  const mainTree = await command('git', ['rev-parse', 'HEAD^{tree}'], { cwd: proof });
  const chosenTree = await command('git', ['rev-parse', `origin/candidates/${task}/${decision.pick}^{tree}`], { cwd: proof });
  assert.equal(mainTree, chosenTree);
  await command('git', ['fsck', '--strict'], { cwd: proof });
  await command('git', ['repack', '-ad'], { cwd: proof });
  for (const name of await readdir(join(proof, '.git/objects/pack'))) if (name.endsWith('.pack')) await command('git', ['index-pack', '--strict', join(proof, '.git/objects/pack', name)], { cwd: proof });
  const log = await command('git', ['log', '--notes=heddle*', '-1', 'main'], { cwd: proof });
  assert.match(log, new RegExp(`Chosen:\\s+${decision.pick}`));
  assert.match(log, new RegExp(`Rejected:\\s+${agents.find(a => a !== decision.pick)}`));
  assert.match(log, /Heddle-State:/); assert.match(log, /Heddle-Change:/);
  assert.ok(log.includes('SCRIPTED TEST CHOICE'));
  assert.ok(log.includes('native-reviewer'));
  assert.ok(!log.includes('Co-Authored-By: Claude'));
  const why = await request(`${api}/why/${main}`);
  assert.equal(why.verify.sha, main);
  for (const key of ['exportRoundTrip', 'treeMatch', 'fsck']) assert.equal(why.verify[key], true);
  const directory = JSON.parse(await command('git', ['show', 'origin/heddle/agents:.heddle-agents.json'], { cwd: proof }));
  await save('published-agent-directory.json', directory);
  const refs = await command('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/notes', 'refs/remotes/origin/candidates', 'refs/remotes/origin/heddle/agents', 'refs/heads/main'], { cwd: proof });
  await writeFile(join(evidence, 'git-log.txt'), log + '\n', { mode: 0o600 });
  await writeFile(join(evidence, 'refs.txt'), refs + '\n', { mode: 0o600 });
  await save('why.json', why); await save('decision.json', { reply, decision });
  mark('fresh-clone-proof-complete');
  await save('result.json', { genuineNativeAgents: true, ...(replaySource ? { runKind: 'historical-candidate-decision-replay', replaySource, freshCodingTasks: false, freshReviewerTask: false } : {}), baseSha, pushed, main, mainTree, chosenTree, decision, reviewTurn: turn, identity, seconds: (Date.now() - start) / 1000, timeline, verification: why.verify,
    checks: ['separate enrolled Git forks', 'operator-reviewed complete trees before push', 'concurrent ordinary Git pushes', 'exact source OIDs', 'native capture signatures', 'overlapping candidate conflicts', 'locked candidate tests', 'genuine independent native review', 'signed native review discussion', 'explicitly scripted test choice', 'fresh clone', 'exact candidate refs', 'selected tree equality', 'strict fsck', 'strict index-pack', 'notes and native trailers', 'SHA-bound publication verification'],
    limitations: ['local Wrangler/workerd SQLite and R2', 'local fake Artifacts smart HTTP service', 'host native engine, not deployed Container', 'provider label is declared provenance, not model-provider attestation', 'custodial signing keys', 'reviewer is a real native collaboration subagent, not Workers AI', 'scripted test choice, no real human decision', 'whole-tree review gate is not an arbitrary-code sandbox', 'no cloud deployment or external publication'] });
  console.log(replaySource ? 'GENUINE CANDIDATE DECISION REPLAY PASS (no new coding/reviewer session)' : 'GENUINE REHEARSAL PASS');
} catch (error) {
  console.error(`GENUINE REHEARSAL FAILED at ${stage}: ${error instanceof assert.AssertionError ? error.message : 'implementation/dependency error (credentials suppressed)'}`);
  await save('failure.json', { stage, elapsedMs: Date.now() - start, error: error instanceof assert.AssertionError ? error.message : error.name });
  process.exitCode = 1;
} finally {
  if (wrangler?.pid) { try { process.kill(-wrangler.pid, 'SIGTERM'); } catch {} await pause(1000); try { process.kill(-wrangler.pid, 'SIGKILL'); } catch {} }
  if (engine) await engine.close(); if (fake) await fake.close();
}
