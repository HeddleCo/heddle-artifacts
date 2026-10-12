// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, readlink, rename, appendFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, git } from '../lib/process.mjs';
import { verifyCapture } from '../lib/signatures.mjs';
import { verifyAttestation } from '../lib/attestations.mjs';
import { createReviewedFixtureEntry } from '../lib/trusted-tests.mjs';

const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'track-b-e2e-'));
const engineFile = process.env.ENGINE_FILE || fileURLToPath(new URL('../engine.mjs', import.meta.url));
const binary = process.env.HEDDLE_BIN || '/home/scratch/heddle-0.30-bin/bin/heddle';
const state = join(root, 'state');
const trustedManifest = join(root, 'operator-reviewed-test-trees.json');
const canonical = join(root, 'p.git');
let counter = 0;
const call = async (cmd, body = {}, expected = 0, target = state, raw = false) => {
  const result = await run(process.execPath, [engineFile, cmd], { input: Buffer.isBuffer(body) ? body : JSON.stringify(body), env: { ENGINE_STATE_DIR: target, HEDDLE_TRUSTED_TEST_MANIFEST: trustedManifest, HEDDLE_BIN: binary, TMPDIR: process.env.TMPDIR || '/tmp' }, allowFailure: true });
  assert.equal(result.code, expected, `${cmd}: ${result.stdout.toString()} ${result.stderr.toString()}`);
  if (cmd === 'snapshot' || raw) return result.stdout;
  assert.equal(result.stdout.toString().trim().split('\n').length, 1, 'one JSON line');
  const parsed = JSON.parse(result.stdout);
  await appendFile(join(root, 'contract.jsonl'), JSON.stringify({ cmd, ...(Buffer.isBuffer(body) ? {} : { input: body }), output: parsed, exit: result.code }) + '\n');
  return parsed;
};
const mutate = (cmd, body) => call(cmd, { opId: `e2e-${++counter}`, ...body });
assert.equal((await call('selftest')).ok, true);
const digest = async (dir, hash = createHash('sha256')) => {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name); hash.update(entry.name);
    if (entry.isDirectory()) await digest(path, hash);
    else if (entry.isSymbolicLink()) hash.update(await readlink(path));
    else hash.update(await readFile(path));
  }
  return hash;
};
const seed = join(root, 'seed');
await mkdir(join(seed, 'src'), { recursive: true });
await git(seed, ['init', '-b', 'main']);
await git(seed, ['config', 'user.name', 'Untrusted Git author']);
await git(seed, ['config', 'user.email', 'untrusted@example.invalid']);
const seedFiles = {
  'src/table.ts': '// SPDX-License-Identifier: Apache-2.0\nexport function parseRow(row: string) { return row.split("|"); }\n',
  'README.md': '<!-- SPDX-License-Identifier: Apache-2.0 -->\n# Seed\n',
  'package.json': JSON.stringify({ scripts: { test: 'node --test test.mjs' } }),
  'test.mjs': '// SPDX-License-Identifier: Apache-2.0\nimport { test } from "node:test"; import { readFileSync } from "node:fs"; import assert from "node:assert/strict"; test("parser remains exported", () => assert.match(readFileSync("src/table.ts", "utf8"), /export function parseRow/));\n',
};
for (const [path, contents] of Object.entries(seedFiles)) await writeFile(join(seed, path), contents);
const parserSource = id => `// SPDX-License-Identifier: Apache-2.0\nexport function parseRow(row: string) { return row.${id === 'alice' ? 'replace(/\\\\\\|/g, "PIPE").split("|")' : 'split(/(?<!\\\\)\\|/)'}; }\n`;
const carolReadme = '<!-- SPDX-License-Identifier: Apache-2.0 -->\n# Parser documentation\n';
const updatedCarolReadme = '<!-- SPDX-License-Identifier: Apache-2.0 -->\n# Parser documentation, updated after restore\n';
const reviewedFiles = {
  seed: seedFiles,
  alice: { ...seedFiles, 'src/table.ts': parserSource('alice') },
  bob: { ...seedFiles, 'src/table.ts': parserSource('bob') },
  carol: { ...seedFiles, 'README.md': carolReadme },
  'carol-updated': { ...seedFiles, 'README.md': updatedCarolReadme },
};
await writeFile(trustedManifest, JSON.stringify({ version: 1, trees: Object.entries(reviewedFiles).map(([name, files]) => createReviewedFixtureEntry(name, files)) }), { mode: 0o600 });
await git(seed, ['add', '.']);
await git(seed, ['commit', '-m', 'Seed']);
await git(root, ['init', '--bare', '--initial-branch=main', canonical]);
assert.equal((await call('init', { opId: 'bad-seed', project: 'p', canonical: { remote: canonical }, seed: {} }, 2)).error.code, 'invalid_seed');
await mutate('init', { project: 'p', canonical: { remote: canonical }, seed: { importUrl: seed } });
await mutate('task.create', { task: 'parser-escapes', intent: 'Support escaped pipes' });
await mutate('task.create', { task: 'docs-readme', intent: 'Document the parser' });
const agents = {};
for (const id of ['alice', 'bob', 'carol', 'reviewer', 'luke']) agents[id] = await mutate('agent.enroll', { agent: { id, kind: id === 'luke' ? 'human' : id === 'reviewer' ? 'reviewer' : 'agent', displayName: id, provider: 'scripted', model: 'fixture' } });
const unusualOp = { opId: 'constructor', agent: { id: 'reviewer', kind: 'reviewer', displayName: 'reviewer' } };
assert.deepEqual(await call('agent.enroll', unusualOp), agents.reviewer);
const journalBeforeReplay = await readFile(join(state, 'engine.json'));
assert.deepEqual(await call('agent.enroll', unusualOp), agents.reviewer);
assert.deepEqual(await readFile(join(state, 'engine.json')), journalBeforeReplay);
const pushes = [];
for (const [id, task] of [['alice', 'parser-escapes'], ['bob', 'parser-escapes'], ['carol', 'docs-readme']]) {
  const fork = join(root, `p--${task}--${id}.git`);
  await git(root, ['clone', '--bare', canonical, fork]);
  const opened = await mutate('lane.open', { task, agent: id });
  // Before any decision there is nothing to brief, but every agent lane still gets a signed briefing.
  assert.match(opened.briefing.hash, /^[0-9a-f]{64}$/); assert.deepEqual(opened.briefing.annotations, []);
  const checkout = join(root, `${id}-git`);
  await git(root, ['clone', fork, checkout]);
  await git(checkout, ['config', 'user.name', 'Forged author']);
  await git(checkout, ['config', 'user.email', 'forged@example.invalid']);
  if (id === 'carol') await writeFile(join(checkout, 'README.md'), carolReadme);
  else await writeFile(join(checkout, 'src/table.ts'), parserSource(id));
  await git(checkout, ['add', '.']);
  await git(checkout, ['commit', '-m', `${id} candidate`]);
  await git(checkout, ['push', 'origin', 'HEAD:main']);
  pushes.push({ task, agent: id, fork: { remote: fork }, ref: 'refs/heads/main', sha: await git(checkout, ['rev-parse', 'HEAD']) });
}
const privateLeaseFile = join(state, 'lanes/parser-escapes/bob/.heddle/engine-lease.json');
const leaseBytes = await readFile(privateLeaseFile), badLease = JSON.parse(leaseBytes); badLease.token = 'invalid-token';
await writeFile(privateLeaseFile, JSON.stringify(badLease), { mode: 0o600 });
try { assert.equal((await call('ingest', { opId: 'invalid-lease', items: [pushes[1]], runTests: false }, 2)).error.code, 'lease_invalid'); }
finally { await writeFile(privateLeaseFile, leaseBytes, { mode: 0o600 }); }
const ingested = await mutate('ingest', { items: pushes, runTests: true });
assert.equal(ingested.results.length, 3);
assert(ingested.results.every(r => r.status === 'captured'), 'B-T1 every batch item captured');
const a = await call('candidates', { task: 'parser-escapes' });
const b = await call('candidates', { task: 'docs-readme' });
assert.equal(a.candidates.length, 2);
assert.deepEqual(a.candidates.find(c => c.agent === 'alice').conflicts[0]?.with, ['bob'], 'B-T1 alice conflict attributed to bob');
assert.deepEqual(a.candidates.find(c => c.agent === 'bob').conflicts[0]?.with, ['alice'], 'B-T1 bob conflict attributed to alice');
assert.equal(b.candidates.length, 1);
assert.deepEqual(b.candidates[0].conflicts, []);
console.log('B-T1 PASS: one ingest batch; parser candidates alice↔bob; docs candidate carol clean');
const guardedVerifier = (await import(pathToFileURL(join(dirname(engineFile), 'lib/signatures.mjs')))).verifyCapture;
for (const candidate of [...a.candidates, ...b.candidates]) {
  assert.equal(candidate.signedBy, agents[candidate.agent].publicKey, 'B-T2 enrolled signer');
  const shown = JSON.parse((await run(binary, ['--output', 'json', 'show', candidate.state], { cwd: join(state, 'repo'), env: { HEDDLE_HOME: join(state, 'agents', candidate.agent, 'home') } })).stdout);
  assert.equal(await verifyCapture(join(state, 'repo', '.heddle'), shown, agents[candidate.agent].publicKey), candidate.signedBy, 'B-T2 native signature verifies');
  assert.equal(shown.principal.name, candidate.agent, 'Git author cannot select Heddle principal');
  const wrongKey = agents[candidate.agent === 'alice' ? 'bob' : 'alice'].publicKey;
  await assert.rejects(() => guardedVerifier(join(state, 'repo', '.heddle'), shown, wrongKey), { code: 'identity_mismatch' }, 'B-T2 wrong enrolled key must be rejected');
}
const mismatch = await mutate('ingest', { items: [{ ...pushes[0], agent: 'bob' }], runTests: false });
assert.equal(mismatch.results[0].reason, 'lane_mismatch');
const metadata = JSON.parse(await readFile(join(state, 'engine.json')));
const bobLane = metadata.lanes['parser-escapes/bob'];
const unauthorized = await run(binary, ['--output', 'json', 'agent', 'capture', '--lease', bobLane.leaseId, '-m', 'unauthorized'], { cwd: bobLane.path, env: { HEDDLE_HOME: join(state, 'agents', 'bob', 'home') }, allowFailure: true });
assert.notEqual(unauthorized.code, 0, 'B-T2 capture must require a token');
console.log('B-T2 PASS: all native signatures match enrolled keys; alice fork→bob rejected lane_mismatch; capture without token rejected');
const reviewTurn = await mutate('discuss', { task: 'parser-escapes', author: 'reviewer', body: 'Bob preserves the public API' });
await mutate('discuss', { task: 'parser-escapes', author: 'luke', body: 'Agree: API stability matters', replyTo: reviewTurn.id });
const beforeStale = (await digest(state)).digest('hex');
const stale = await call('decide', { opId: 'stale', task: 'parser-escapes', decider: 'luke', pick: 'bob', rationale: 'Pick Bob', expectHeads: [] }, 2);
assert.equal(stale.error.code, 'stale');
assert.equal((await digest(state)).digest('hex'), beforeStale, 'B-T4 every repository and metadata file unchanged');
console.log('B-T4 PASS: stale expectHeads exits 2 with stale; every state file unchanged');
const decisionOp = `e2e-${counter + 1}`;
const decision = await mutate('decide', { task: 'parser-escapes', decider: 'luke', pick: 'bob', rationale: 'Keep the API stable', expectHeads: a.heads });
const decidedState = JSON.parse(await readFile(join(state, 'engine.json')));
const rationaleTurn = decidedState.turns.find(t => t.author === 'luke' && t.body === decision.rationale);
assert(rationaleTurn, 'native decision rationale turn is retained');
assert.equal(decision.at, rationaleTurn.at, 'Decision.at is the native decision turn time');
assert.equal(decidedState.projection.at, decision.at, 'projection uses the persisted native decision time');
assert(Date.parse(decision.at) > Date.parse(reviewTurn.at), 'decision follows the earlier review, not the chosen Capture');
const published = await mutate('publish', { canonical: { remote: canonical } });
assert.deepEqual(published.verify, { exportRoundTrip: true, treeMatch: true, fsck: true }, 'B-T3 projection checks');
for (const push of pushes) assert.equal(await git(canonical, ['rev-parse', `refs/heads/candidates/${push.task}/${push.agent}`]), push.sha);
assert.equal(await git(canonical, ['rev-parse', 'main^{tree}']), await git(canonical, ['rev-parse', 'candidates/parser-escapes/bob^{tree}']));
const fresh = join(root, 'fresh');
await git(root, ['clone', canonical, fresh]);
await git(fresh, ['fetch', 'origin', '+refs/notes/*:refs/notes/*']);
await git(fresh, ['fsck', '--strict']);
const pack = (await run('git', ['--git-dir', canonical, 'pack-objects', '--all', '--stdout'])).stdout;
await run('git', ['index-pack', '--strict', '--stdin'], { cwd: fresh, input: pack });
const log = await git(fresh, ['log', '--notes=heddle*', '-1', 'main']);
assert.match(log, /Chosen:\s+bob/); assert.match(log, /Rejected:\s+alice/);
assert.match(log, /Heddle-State:/); assert.match(log, /Heddle-Change:/);
console.log('B-T3 PASS: original candidate SHAs; chosen tree; export round trip; fresh fsck/index-pack --strict; Chosen: bob / Rejected: alice in git log');
const snapshot = await call('snapshot');
const restored = join(root, 'restored');
await call('restore', snapshot, 0, restored);
assert.deepEqual(await call('candidates', { task: 'parser-escapes' }, 0, restored, true), await call('candidates', { task: 'parser-escapes' }, 0, state, true), 'B-T5 candidates stdout byte-identical');
const withOriginalOffline = async operation => {
  const offline = join(root, 'original-offline'); await rename(state, offline);
  try { return await operation(); } finally { await rename(offline, state); }
};
const restoredPublish = await withOriginalOffline(() => call('publish', { opId: 'restored-publish', canonical: { remote: canonical } }, 0, restored));
assert.equal(restoredPublish.main, published.main, 'B-T3 restored export SHA');
const restoredDecisionState = JSON.parse(await readFile(join(restored, 'engine.json')));
assert.equal(restoredDecisionState.decisions['parser-escapes'].at, decision.at, 'restored decision keeps its native turn time');
assert.equal(restoredDecisionState.projection.at, decision.at, 'restored projection keeps the same timestamp pin');
console.log('B-T5 PASS: fresh-directory restore; candidates byte-identical; restored publish same main SHA');
const duplicates = await mutate('ingest', { items: pushes, runTests: false });
assert(duplicates.results.every(r => r.status === 'duplicate'));
console.log('Idempotency PASS: repeated lane/SHA batch returns duplicates');
const replay = await call('decide', { opId: decisionOp, task: 'parser-escapes', decider: 'luke', pick: 'bob', rationale: 'Keep the API stable', expectHeads: a.heads });
assert.deepEqual(replay, decision, 'recorded decision replay');
assert.match((await call('why', { sha: published.main })).narrative, /Keep the API stable/);
assert.match((await call('diff', { task: 'parser-escapes', agent: 'bob', maxBytes: 64 })).diff, /diff --git/);
const signedState = JSON.parse(await readFile(join(state, 'engine.json')));
for (const turn of signedState.turns) assert.equal(verifyAttestation(signedState.attestations[turn.id], agents[turn.author].publicKey), turn.signedBy);
const decisionProof = signedState.attestations[signedState.decisionAttestations['parser-escapes']];
assert.equal(verifyAttestation(decisionProof, agents.luke.publicKey), agents.luke.publicKey);
assert.deepEqual(JSON.parse(decisionProof.payload).decision, decision);
assert.throws(() => verifyAttestation({ ...decisionProof, payload: decisionProof.payload + 'tampered' }, agents.luke.publicKey), { code: 'identity_mismatch' });
console.log('Collaboration PASS: native envelopes signed with enrolled reviewer/human keys; decision binds exact states and SHA; tampering rejected');
const carolCheckout = join(root, 'carol-git');
await writeFile(join(carolCheckout, 'README.md'), updatedCarolReadme);
await git(carolCheckout, ['add', '.']); await git(carolCheckout, ['commit', '-m', 'Carol update']); await git(carolCheckout, ['push', 'origin', 'HEAD:main']);
const update = { ...pushes[2], sha: await git(carolCheckout, ['rev-parse', 'HEAD']) };
const batch = await withOriginalOffline(() => call('ingest', { opId: 'restored-batch', items: [update, update], runTests: true }, 0, restored));
assert.deepEqual(batch.results.map(r => r.status), ['captured', 'duplicate']);
assert.equal(batch.results[0].candidate.state, batch.results[1].candidate.state);
assert.equal(batch.results[0].candidate.tests.status, 'pass');
console.log('Lifecycle PASS: restored checkout captures a new push; same-batch duplicate captured once; opId replay, diff and why verified');
// The restored ingest published Carol's newer candidate ref. Bring the original
// snapshot to that same source SHA before making another main-last publication.
await mutate('ingest', { items: [update], runTests: true });
// Native capture is allowed, but arbitrary candidate npm code must never share
// the custodial engine process permissions. Use only a synthetic public marker.
await mutate('task.create', { task: 'unreviewed-code', intent: 'Prove unknown source is captured without execution' });
const unreviewed = await mutate('agent.enroll', { agent: { id: 'unreviewed', kind: 'agent', displayName: 'Unreviewed fixture' } });
const unknownFork = join(root, 'p--unreviewed-code--unreviewed.git');
await git(root, ['clone', '--bare', canonical, unknownFork]);
const followUp = await mutate('lane.open', { task: 'unreviewed-code', agent: 'unreviewed' });
// Context carries forward: a lane opened after the parser decision is briefed with the decider's rationale.
const carried = followUp.briefing.annotations.find(a => a.content === 'Keep the API stable');
assert.ok(carried, 'decision rationale reaches the next lane briefing');
assert.equal(carried.kind, 'rationale'); assert.equal(carried.target, 'src/table.ts'); assert.match(carried.attribution, /Luke/i);
assert.match(followUp.briefing.hash, /^[0-9a-f]{64}$/);
const unknownCheckout = join(root, 'unknown-git'); await git(root, ['clone', unknownFork, unknownCheckout]);
const sentinel = join(state, 'synthetic-custody-sentinel.txt'), attemptedRead = join(state, 'synthetic-attempted-read.txt');
await writeFile(sentinel, 'PUBLIC-SYNTHETIC-CUSTODY-MARKER\n', { mode: 0o600 });
await writeFile(join(unknownCheckout, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node malicious.mjs' } }));
await writeFile(join(unknownCheckout, 'malicious.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(attemptedRead)}, fs.readFileSync(${JSON.stringify(sentinel)})); fs.writeFileSync(${JSON.stringify(sentinel)}, 'OVERWRITTEN');`);
await git(unknownCheckout, ['add', '.']);
await git(unknownCheckout, ['-c', 'user.name=Unreviewed fixture', '-c', 'user.email=unreviewed@example.invalid', 'commit', '-m', 'Unreviewed synthetic execution probe']);
await git(unknownCheckout, ['push', 'origin', 'HEAD:main']);
const unknown = await mutate('ingest', { runTests: true, items: [{ task: 'unreviewed-code', agent: 'unreviewed', fork: { remote: unknownFork }, ref: 'refs/heads/main', sha: await git(unknownCheckout, ['rev-parse', 'HEAD']) }] });
assert.equal(unknown.results[0].status, 'captured');
assert.equal(unknown.results[0].candidate.signedBy, unreviewed.publicKey);
assert.equal(unknown.results[0].candidate.tests.status, 'skipped');
assert.match(unknown.results[0].candidate.tests.summary, /^Tests withheld:/);
assert.equal(await readFile(sentinel, 'utf8'), 'PUBLIC-SYNTHETIC-CUSTODY-MARKER\n');
await assert.rejects(access(attemptedRead), { code: 'ENOENT' });
console.log('Trusted execution PASS: unknown malicious fixture remains a signed native candidate; npm execution withheld; synthetic custody sentinel unchanged and unread');
// Exercise the trusted observation endpoint on a real native Capture. The
// output below is a test-runner fixture, not a claim of a live Cloudflare run.
await writeFile(join(unknownCheckout, 'README.md'), '# Isolated observation fixture\n');
await git(unknownCheckout, ['add', 'README.md']);
await git(unknownCheckout, ['-c', 'user.name=Unreviewed fixture', '-c', 'user.email=unreviewed@example.invalid', 'commit', '-m', 'Isolated candidate']);
await git(unknownCheckout, ['push', 'origin', 'HEAD:main']);
const isolatedSha = await git(unknownCheckout, ['rev-parse', 'HEAD']);
const isolated = await mutate('ingest', { runTests: true, isolateUnreviewed: true, items: [{ task: 'unreviewed-code', agent: 'unreviewed', fork: { remote: unknownFork }, ref: 'refs/heads/main', sha: isolatedSha }] });
const isolatedCandidate = isolated.results[0].candidate;
assert.equal(isolatedCandidate.tests.status, 'pending');
const pendingHeads = (await call('candidates', { task: 'unreviewed-code' })).heads;
assert.equal((await call('decide', { opId: 'pending-isolated', task: 'unreviewed-code', decider: 'luke', pick: 'unreviewed', rationale: 'Select', expectHeads: pendingHeads }, 2)).error.code, 'tests_pending');
const observedRun = { sourceSha: isolatedSha, treeSha: isolatedCandidate.treeSha, installExitCode: 0, testExitCode: 0, output: '# pass 14\n# fail 0\n', durationMs: 50 };
assert.equal((await mutate('tests.record', { task: 'unreviewed-code', agent: 'unreviewed', sourceSha: unknown.results[0].candidate.sourceSha, run: { ...observedRun, sourceSha: unknown.results[0].candidate.sourceSha } })).ignored, true);
const observed = await mutate('tests.record', { task: 'unreviewed-code', agent: 'unreviewed', sourceSha: isolatedSha, run: observedRun });
assert.equal(observed.candidate.tests.status, 'pass');
assert.equal(verifyAttestation(observed.candidate.tests.observation, observed.candidate.tests.observation.publicKey), observed.candidate.tests.observation.publicKey);
assert.match((await call('why', { sha: isolatedSha })).narrative, /isolated sandbox/);
const isolatedDecision = await mutate('decide', { task: 'unreviewed-code', decider: 'luke', pick: 'unreviewed', rationale: 'Observed isolated tests pass', expectHeads: pendingHeads });
await mutate('publish', { canonical: { remote: canonical } });
assert.match(await git(canonical, ['notes', '--ref=heddle-why', 'show', isolatedDecision.mainSha]), /isolated sandbox/);
assert.match(await git(canonical, ['notes', '--ref=heddle-why', 'show', isolatedSha]), /Test proof:/);
assert.equal(await readFile(sentinel, 'utf8'), 'PUBLIC-SYNTHETIC-CUSTODY-MARKER\n');
await assert.rejects(access(attemptedRead), { code: 'ENOENT' });
console.log('Isolated observations PASS: real native Capture stays key-safe; pending decision rejected; old SHA ignored; ed25519 proof verified; sandbox provenance and proof survive publication in Git notes');
console.log(`Evidence scratch: ${root}`);
