// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { startFakeArtifacts } from './fake-artifacts/server.mjs';
import { startEngineDevserver } from './engine-devserver.mjs';
import { git } from './fake-artifacts/binding.mjs';
const stub = process.argv.includes('--stub');
const storyline = process.argv.includes('--storyline');
if (storyline && stub) throw new Error('The integrated storyline requires the real engine');
const engineScript = process.env.ENGINE_SCRIPT ?? resolve('engine/engine.mjs');
if (!stub) {
  try { await access(engineScript); } catch { console.error('A-T6 BLOCKED: Track B engine/engine.mjs is not available; pass ENGINE_SCRIPT after Track B lands.'); process.exit(2); }
  const source = await readFile(engineScript, 'utf8');
  if (source.includes('Engine command is not implemented yet')) { console.error('A-T6 BLOCKED: Track B engine currently implements selftest only.'); process.exit(2); }
}
const temp = await mkdtemp(join(tmpdir(), 'track-a-flow-'));
const project = `demo-${randomBytes(4).toString('hex')}`, token = randomBytes(32).toString('hex');
const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port; await new Promise(r => listener.close(r));
const origin = `http://127.0.0.1:${port}`, base = `${origin}/api/projects/${project}`;
let fake, engine, wrangler, stage = 'startup';
async function api(url, body, authorized = true) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authorized ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function ok(url, body, authorized = true) { const result = await api(url, body, authorized); assert.equal(result.status, 200, `API status ${result.status}, error ${result.body.error ?? 'none'}`); return result.body; }
async function waitFor(fn, timeout = 120000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw new Error('Flow deadline exceeded'); }
try {
  fake = await startFakeArtifacts({ root: join(temp, 'artifacts'), port: 0, eventUrl: `${origin}/__dev/events` });
  engine = await startEngineDevserver({ root: join(temp, 'engine'), port: 0, stub, engine: engineScript });
  wrangler = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'wrangler.dev.jsonc', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', join(temp, 'wrangler'), '--var', `OPERATOR_TOKEN:${token}`, '--var', `DEMO_PROJECT:${project}`, '--var', `FAKE_ARTIFACTS_URL:${fake.origin}`, '--var', `ENGINE_DEV_URL:${engine.origin}`], { detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(temp, 'wrangler.log'), XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'pipe', 'pipe'] });
  // Wrangler prints binding configuration; discard it so operator credentials never enter evidence.
  wrangler.stdout.resume(); wrangler.stderr.resume();
  await waitFor(async () => { try { return (await fetch(`${origin}/login`)).ok; } catch { return false; } }, 30000);
  if (storyline) {
    stage = 'integrated-storyline';
    const demo = spawn(process.execPath, ['demo/lib/harness.mjs', 'run', '--url', origin, '--project', project, '--dir', join(temp, 'demo'), '--mode', 'scripted', '--delay', '0', '--timeout', '180'], {
      env: { ...process.env, OPERATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe']
    });
    demo.stdout.pipe(process.stdout); demo.stderr.pipe(process.stderr);
    const status = await new Promise((resolve, reject) => { demo.on('error', reject); demo.on('close', resolve); });
    assert.equal(status, 0, 'Integrated Track D storyline');
    const saved = JSON.parse(await readFile(join(temp, 'demo', '.demo.json'), 'utf8'));
    const proof = JSON.parse(await readFile(join(temp, 'demo', String(saved.generation), 'result.json'), 'utf8'));
    const why = await ok(`${base}/why/${proof.main}`, undefined, false);
    assert.equal(why.verify?.sha, proof.main);
    for (const check of ['exportRoundTrip', 'treeMatch', 'fsck']) assert.equal(why.verify[check], true);
    if (process.env.LOCAL_FLOW_EVIDENCE) await writeFile(process.env.LOCAL_FLOW_EVIDENCE, JSON.stringify({ ...proof, verification: why.verify, transport: 'local Wrangler/workerd SQLite/R2; real stock Heddle engine process; fake Artifacts; stub reviewer; scripted decision' }, null, 2) + '\n');
    console.log('INTEGRATED STORYLINE PASS: real engine + Worker/R2 + Track D Git clients; recorded per-SHA verification; Artifacts/reviewer fixtures, scripted decision');
  } else {
  stage = 'F1';
  await ok(`${origin}/api/projects`, { id: project, seed: { template: 'demo' } });
  console.log(`F1 PASS: project initialized via wrangler dev (${stub ? 'explicit engine fixture' : 'real engine'})`);
  if (stub) {
    const seed = join(temp, 'seed'); await mkdir(join(seed, 'src'), { recursive: true });
    await git(['init', '--initial-branch=main'], seed); await git(['config', 'user.name', 'Fixture'], seed); await git(['config', 'user.email', 'fixture@example.invalid'], seed);
    await writeFile(join(seed, 'src/table.ts'), 'export const parseRow = (line: string) => line.split("|");\n'); await writeFile(join(seed, 'README.md'), 'local fixture\n');
    await git(['add', '.'], seed); await git(['commit', '-m', 'Fixture seed'], seed);
    const repo = await fake.binding.get(project), seedToken = await repo.createToken('write', 600);
    await git(['-c', `http.extraHeader=Authorization: Bearer ${seedToken.plaintext}`, 'push', fake.binding.remote(project), 'HEAD:main'], seed); await repo.revokeToken(seedToken.id);
  }
  stage = 'F2';
  await ok(`${base}/tasks`, { slug: 'parser-escapes', intent: 'Concurrent parser candidates' });
  await ok(`${base}/tasks`, { slug: 'docs-readme', intent: 'Document the API' });
  const enrollments = new Map();
  for (const [agent, task] of [['alice', 'parser-escapes'], ['bob', 'parser-escapes'], ['carol', 'docs-readme'], ['reviewer', 'parser-escapes']]) enrollments.set(agent, await ok(`${base}/tasks/${task}/agents`, { id: agent, kind: agent === 'reviewer' ? 'reviewer' : 'agent', displayName: agent }));
  await ok(`${base}/humans`, { id: 'luke', displayName: 'Luke' });
  console.log('F2 PASS: two tasks; alice, bob, carol and reviewer enrolled; human identity registered');
  stage = 'F3';
  const pushed = {};
  await Promise.all(['alice', 'bob', 'carol'].map(async agent => {
    const enrollment = enrollments.get(agent), dir = join(temp, agent);
    const auth = ['-c', `http.extraHeader=Authorization: Bearer ${enrollment.fork.token}`];
    await git([...auth, 'clone', enrollment.fork.remote, dir]);
    await git(['config', 'user.name', agent], dir); await git(['config', 'user.email', `${agent}@example.invalid`], dir);
    const file = join(dir, agent === 'carol' ? 'README.md' : 'src/table.ts');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original + (agent === 'carol' ? '\nLocal flow documentation.\n' : `\nexport const trackAConflict = ${agent === 'alice' ? '1' : '2'};\n`));
    await git(['add', '.'], dir); await git(['commit', '-m', `${agent} candidate`], dir);
    pushed[agent] = (await git(['rev-parse', 'HEAD'], dir)).trim();
    await git([...auth, 'push', enrollment.fork.remote, 'HEAD:main'], dir);
  }));
  const parser = await waitFor(async () => { const task = await ok(`${base}/tasks/parser-escapes`); return task.candidates.length === 2 ? task : false; });
  const docs = await waitFor(async () => { const task = await ok(`${base}/tasks/docs-readme`); return task.candidates.length === 1 ? task : false; });
  for (const candidate of [...parser.candidates, ...docs.candidates]) assert.equal(candidate.sourceSha, pushed[candidate.agent]);
  assert.ok(parser.candidates.every(c => c.conflicts.some(x => x.with.includes(c.agent === 'alice' ? 'bob' : 'alice')))); assert.equal(docs.candidates[0].conflicts.length, 0);
  console.log('F3 PASS: three concurrent real Git pushes => two conflicting parser candidates + one clean docs candidate; exact source SHAs');
  stage = 'F4';
  const reviewed = await waitFor(async () => { const task = await ok(`${base}/tasks/parser-escapes`); return task.review && task.turns.length ? task : false; });
  assert.equal(reviewed.turns[0].kind, 'reviewer');
  const turn = await ok(`${base}/tasks/parser-escapes/turns`, { body: 'Keep the second alternative and its rationale.', as: 'luke' }); assert.equal(turn.author, 'luke');
  console.log(`F4 PASS: debounced reviewer discussion (${reviewed.review.model}); human reply recorded`);
  stage = 'F5';
  const decisionInput = { pick: 'bob', decider: 'luke', rationale: 'Choose Bob and preserve Alice as an attributed alternative.', expectHeads: reviewed.heads };
  assert.equal((await api(`${base}/tasks/parser-escapes/decision`, decisionInput, false)).status, 403);
  assert.equal((await api(`${base}/tasks/parser-escapes/decision`, { ...decisionInput, expectHeads: ['stale'] })).status, 409);
  if (process.argv.includes('--break-decision')) decisionInput.expectHeads = ['stale'];
  const decision = await ok(`${base}/tasks/parser-escapes/decision`, decisionInput);
  const why = await ok(`${base}/why/${decision.mainSha}`, undefined, false); assert.match(why.narrative, /Chosen:\s*bob/); assert.match(why.narrative, /Rejected:\s*alice/);
  assert.equal(why.verify?.sha, decision.mainSha);
  for (const check of ['exportRoundTrip', 'treeMatch', 'fsck']) assert.equal(why.verify[check], true, `Publication verification ${check}`);
  console.log('F5 PASS: missing auth 403; stale heads 409; current decision lands and public why names chosen/rejected candidates');
  if (!stub) {
    const read = enrollments.get('bob').upstream.readToken, remote = enrollments.get('bob').upstream.remote, clone = join(temp, 'verify');
    const auth = ['-c', `http.extraHeader=Authorization: Bearer ${read}`];
    await git([...auth, 'clone', remote, clone]); await git([...auth, 'fetch', 'origin', '+refs/notes/*:refs/notes/*'], clone);
    assert.equal((await git(['rev-parse', 'HEAD'], clone)).trim(), decision.mainSha);
    for (const agent of ['alice', 'bob']) assert.equal((await git(['rev-parse', `origin/candidates/parser-escapes/${agent}`], clone)).trim(), pushed[agent]);
    assert.equal((await git(['rev-parse', 'HEAD^{tree}'], clone)).trim(), (await git(['rev-parse', 'origin/candidates/parser-escapes/bob^{tree}'], clone)).trim());
    await git(['fsck', '--strict'], clone);
    const log = await git(['log', '--notes=heddle*', '-1', 'main'], clone); assert.match(log, /Chosen:\s*bob/); assert.match(log, /Rejected:\s*alice/);
    console.log('A-T6 PASS: full F1–F5 with real Heddle; canonical SHA/tree, original candidates, notes and fsck verified');
  } else console.log('LOCAL-FLOW PASS: F1–F5 on wrangler dev + real smart HTTP + contract engine/reviewer fixtures; not A-T6 real-engine evidence');
  }
} catch (error) {
  console.error(error instanceof assert.AssertionError ? `Flow assertion FAILED: ${error.message}` : `Local flow FAILED at ${stage}: ${error.message === 'Flow deadline exceeded' ? 'deadline exceeded' : 'implementation/dependency error'} (credentials suppressed).`); process.exitCode = 1;
} finally {
  if (wrangler?.pid) { try { process.kill(-wrangler.pid, 'SIGTERM'); } catch {} await Promise.race([new Promise(r => wrangler.once('exit', r)), new Promise(r => setTimeout(r, 2000))]); try { process.kill(-wrangler.pid, 'SIGKILL'); } catch {} }
  if (engine) await engine.close(); if (fake) await fake.close(); await rm(temp, { recursive: true, force: true });
}
