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
// A control lane (brief: false) on the same task starts with no briefing at all.
await mutate('agent.enroll', { agent: { id: 'control', kind: 'agent', displayName: 'Control fixture' } });
const control = await mutate('lane.open', { task: 'unreviewed-code', agent: 'control', brief: false });
assert.equal(control.briefing, undefined, 'control lanes are not briefed');
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

// ── Combined with main ─────────────────────────────────────────────────────────────────────────
// Two tasks start from the same main. Each candidate passes its own tests. Task A lands; task B is
// then behind main. Heddle merges B with main in a scratch thread; the merged state is projected to
// Git and tested the way the isolated sandbox does (fetch the exact commit, check SHA and tree, run
// the tests). Here the tests are real `node --test` runs, not fixture output.
{
  const state2 = join(root, 'combined-state'), canonical2 = join(root, 'combined.git');
  let ops = 0;
  const call2 = (cmd, body = {}, expected = 0) => call(cmd, body, expected, state2);
  const mutate2 = (cmd, body) => call2(cmd, { opId: `combined-${++ops}`, ...body });
  const files = {
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }) + '\n',
    'src/table.mjs': '// SPDX-License-Identifier: Apache-2.0\n/** Parse one Markdown table row. */\nexport function parseRow(row) {\n  let text = row.trim();\n  if (text.startsWith("|")) text = text.slice(1);\n  if (text.endsWith("|")) text = text.slice(0, -1);\n  return text.split("|").map(cell => cell.trim());\n}\n\n/** Parse a table, ignoring its separator row. */\nexport function parseTable(markdown) {\n  return markdown.trim().split(/\\r?\\n/).filter(line => line.trim() && !/^\\s*\\|?\\s*:?-{3,}/.test(line)).map(parseRow);\n}\n',
    'test/table.test.mjs': '// SPDX-License-Identifier: Apache-2.0\nimport { test } from "node:test"; import assert from "node:assert/strict";\nimport { parseRow, parseTable } from "../src/table.mjs";\ntest("parses a row", () => assert.deepEqual(parseRow("| a | b |"), ["a", "b"]));\ntest("ignores the separator", () => assert.deepEqual(parseTable("| A | B |\\n| --- | --- |\\n| 1 | 2 |"), [["A", "B"], ["1", "2"]]));\n',
  };
  const seed2 = join(root, 'combined-seed');
  for (const [path, contents] of Object.entries(files)) { await mkdir(dirname(join(seed2, path)), { recursive: true }); await writeFile(join(seed2, path), contents); }
  await git(seed2, ['init', '-b', 'main']); await git(seed2, ['add', '.']);
  await git(seed2, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-m', 'Table parser seed']);
  await git(root, ['init', '--bare', '--initial-branch=main', canonical2]);
  await mutate2('init', { project: 'c', canonical: { remote: canonical2 }, seed: { importUrl: seed2 } });
  await mutate2('task.create', { task: 'cell-whitespace', intent: 'Preserve whitespace inside cells' });
  await mutate2('task.create', { task: 'table-shape', intent: 'Return the header separately from the rows' });
  await mutate2('task.create', { task: 'row-case', intent: 'Collapse runs of spaces in cells' });
  await mutate2('task.create', { task: 'column-count', intent: 'Count the columns of a table' });
  const keys = {};
  for (const id of ['erin', 'finn', 'gil', 'hana', 'luke']) keys[id] = (await mutate2('agent.enroll', { agent: { id, kind: id === 'luke' ? 'human' : 'agent', displayName: id, provider: 'scripted', model: 'fixture' } })).publicKey;
  const checkouts = {}, forks = {};
  const edit = async (id, change, message) => {
    const co = checkouts[id];
    for (const [path, update] of Object.entries(change)) { await mkdir(dirname(join(co, path)), { recursive: true }); await writeFile(join(co, path), typeof update === 'function' ? update(await readFile(join(co, path), 'utf8')) : update); }
    await git(co, ['add', '.']); await git(co, ['-c', `user.name=${id}`, '-c', `user.email=${id}@example.invalid`, 'commit', '-m', message]);
    await git(co, ['push', 'origin', 'HEAD:main']);
    return git(co, ['rev-parse', 'HEAD']);
  };
  const lanes = { erin: 'cell-whitespace', finn: 'table-shape', gil: 'row-case', hana: 'column-count' };
  for (const [id, task] of Object.entries(lanes)) {
    forks[id] = join(root, `c--${task}--${id}.git`); checkouts[id] = join(root, `combined-${id}`);
    await git(root, ['clone', '--bare', canonical2, forks[id]]);
    await mutate2('lane.open', { task, agent: id });
    await git(root, ['clone', forks[id], checkouts[id]]);
  }
  // A: cells keep their whitespace; its own tests are updated to the new behaviour.
  const shaA = await edit('erin', {
    'src/table.mjs': s => s.replace('return text.split("|").map(cell => cell.trim());', 'return text.split("|");'),
    'test/table.test.mjs': s => s.replace('["a", "b"]', '[" a ", " b "]').replace('[["A", "B"], ["1", "2"]]', '[[" A ", " B "], [" 1 ", " 2 "]]'),
    'test/whitespace.test.mjs': '// SPDX-License-Identifier: Apache-2.0\nimport { test } from "node:test"; import assert from "node:assert/strict";\nimport { parseRow } from "../src/table.mjs";\ntest("keeps code indentation", () => assert.deepEqual(parseRow("|    return x; |"), ["    return x; "]));\n',
  }, 'Preserve whitespace inside cells');
  // B: a new function and its own tests, written against the trimming parser B started from.
  const shaB = await edit('finn', {
    'src/table.mjs': s => s + '\n/** Split a table into its header and body rows. */\nexport function readTable(markdown) {\n  const [header = [], ...rows] = parseTable(markdown);\n  return { header, rows };\n}\n',
    'test/read-table.test.mjs': '// SPDX-License-Identifier: Apache-2.0\nimport { test } from "node:test"; import assert from "node:assert/strict";\nimport { readTable } from "../src/table.mjs";\nconst md = "| Name | Age |\\n| --- | --- |\\n| Ann | 31 |\\n| Bo | 7 |";\ntest("returns the header", () => assert.deepEqual(readTable(md).header, ["Name", "Age"]));\ntest("returns the body rows", () => assert.deepEqual(readTable(md).rows, [["Ann", "31"], ["Bo", "7"]]));\ntest("handles a header-only table", () => assert.deepEqual(readTable("| A |"), { header: ["A"], rows: [] }));\n',
  }, 'Return the header separately from the rows');
  // G: edits the same line of parseRow as A, so it cannot merge with A cleanly.
  const shaG = await edit('gil', { 'src/table.mjs': s => s.replace('.map(cell => cell.trim());', '.map(cell => cell.trim().replace(/\\s+/g, " "));') }, 'Collapse runs of spaces in cells');
  // H: also appends a function at the end of src/table.mjs, as B does. Git sees two edits at one spot.
  const shaH = await edit('hana', {
    'src/table.mjs': s => s + '\n/** The number of columns in a table. */\nexport function columnCount(markdown) {\n  return parseTable(markdown)[0]?.length ?? 0;\n}\n',
    'test/column-count.test.mjs': '// SPDX-License-Identifier: Apache-2.0\nimport { test } from "node:test"; import assert from "node:assert/strict";\nimport { columnCount } from "../src/table.mjs";\ntest("counts columns", () => assert.equal(columnCount("| a | b | c |\\n| --- | --- | --- |"), 3));\n',
  }, 'Count the columns of a table');
  const item = (id, sha) => ({ task: lanes[id], agent: id, fork: { remote: forks[id] }, ref: 'refs/heads/main', sha });
  // What CandidateTestSandbox does, against a local remote: fetch the exact commit, check SHA and tree, run the tests.
  const sandbox = async (remote, sha, treeSha) => {
    const dir = await mkdtemp(join(root, 'sandbox-')), start = Date.now();
    await git(dir, ['init', '-q']); await git(dir, ['fetch', '-q', '--no-tags', '--depth=1', remote, sha]); await git(dir, ['checkout', '-q', '--detach', sha]);
    assert.equal(await git(dir, ['rev-parse', 'HEAD^{tree}']), treeSha, 'sandbox checkout matches the recorded tree');
    const tested = await run(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, allowFailure: true, env: { NO_COLOR: '1' } });
    return { sourceSha: sha, treeSha, output: tested.stdout.toString() + tested.stderr.toString(), durationMs: Date.now() - start, installExitCode: 0, testExitCode: tested.code };
  };
  const captured = await mutate2('ingest', { items: [item('erin', shaA), item('finn', shaB), item('gil', shaG), item('hana', shaH)], runTests: true, isolateUnreviewed: true });
  assert(captured.results.every(r => r.status === 'captured' && r.candidate.tests.status === 'pending' && r.candidate.combined === undefined), 'fresh tasks need no combined check');
  for (const id of ['erin', 'finn', 'gil', 'hana']) {
    const c = captured.results.find(r => r.agent === id).candidate;
    const recorded = await mutate2('tests.record', { task: c.task, agent: id, sourceSha: c.sourceSha, run: await sandbox(canonical2, c.sourceSha, c.treeSha) });
    assert.equal(recorded.candidate.tests.status, 'pass', `${id} passes alone`);
  }
  const aloneB = (await call2('candidates', { task: 'table-shape' })).candidates[0].tests;
  assert.equal(aloneB.passed, 5); assert.equal(aloneB.failed, 0);
  const decisionA = await mutate2('decide', { task: 'cell-whitespace', decider: 'luke', pick: 'erin', rationale: 'Code tables need their indentation; callers can trim.', expectHeads: (await call2('candidates', { task: 'cell-whitespace' })).heads });
  await mutate2('publish', { canonical: { remote: canonical2 } });
  // Main advanced. Before the check has run, B cannot land and says why.
  const headsB = (await call2('candidates', { task: 'table-shape' })).heads;
  assert.equal((await call2('decide', { opId: 'combined-early', task: 'table-shape', decider: 'luke', pick: 'finn', rationale: 'r', expectHeads: headsB }, 2)).error.code, 'combined_pending');
  const combineB = { opId: 'combine-table-shape', task: 'table-shape', isolate: true };
  const checked = await call2('combine', combineB);
  const combinedB = checked.candidates[0].combined;
  assert.equal(combinedB.mainSha, decisionA.mainSha); assert.equal(combinedB.candidateSha, shaB);
  assert.equal(combinedB.status, 'pending'); assert.deepEqual(combinedB.conflicts, []);
  assert.equal(combinedB.heddle.conflictCount, 0, 'Heddle merged B with main cleanly'); assert.equal(combinedB.heddle.freshness, 'current');
  assert.match(combinedB.state, /^hs-/);
  assert.deepEqual(await call2('combine', combineB), checked, 'combine opId replay');
  assert.deepEqual((await mutate2('combine', { task: 'table-shape', isolate: true })).candidates[0].combined, combinedB, 'combine is idempotent for the same main');
  // The combined commit is main + B, in canonical where the sandbox fetches it; B's fork is untouched.
  assert.equal(await git(canonical2, ['rev-parse', `refs/heads/combined/table-shape/finn/${combinedB.sha}`]), combinedB.sha);
  assert.equal(await git(canonical2, ['rev-parse', `${combinedB.sha}^1`]), decisionA.mainSha);
  assert.equal(await git(canonical2, ['rev-parse', `${combinedB.sha}^2`]), shaB);
  assert.equal(await git(forks.finn, ['rev-parse', 'main']), shaB, 'agent fork unchanged');
  const mergedSource = await git(canonical2, ['show', `${combinedB.sha}:src/table.mjs`]);
  assert.match(mergedSource, /return text\.split\("\|"\);/); assert.match(mergedSource, /export function readTable/);
  assert.equal((await call2('decide', { opId: 'combined-pending', task: 'table-shape', decider: 'luke', pick: 'finn', rationale: 'r', expectHeads: headsB }, 2)).error.code, 'combined_pending');
  // A result bound to another commit is refused; one for an older candidate is ignored.
  const combinedRun = await sandbox(canonical2, combinedB.sha, combinedB.treeSha);
  assert.equal((await call2('tests.record', { opId: 'combined-bad-binding', task: 'table-shape', agent: 'finn', sourceSha: shaB, combined: { sha: combinedB.sha, mainSha: decisionA.mainSha }, run: { ...combinedRun, treeSha: aloneB.sourceSha } }, 2)).error.code, 'test_binding_mismatch');
  assert.equal((await mutate2('tests.record', { task: 'table-shape', agent: 'finn', sourceSha: shaB, combined: { sha: shaB, mainSha: decisionA.mainSha }, run: combinedRun })).ignored, true);
  const failing = await mutate2('tests.record', { task: 'table-shape', agent: 'finn', sourceSha: shaB, combined: { sha: combinedB.sha, mainSha: decisionA.mainSha }, run: combinedRun });
  const combinedTests = failing.candidate.combined.tests;
  assert.equal(failing.candidate.combined.status, 'fail'); assert.equal(combinedTests.status, 'fail');
  assert.equal(combinedTests.failed, 3, 'B fails combined with main'); assert.equal(combinedTests.passed, 3);
  assert.deepEqual([...combinedTests.failures].sort(), ['handles a header-only table', 'returns the body rows', 'returns the header']);
  assert.match(combinedTests.excerpt, /Name/);
  assert.equal(failing.candidate.tests.status, 'pass', 'its own tests still pass alone');
  const proof = JSON.parse(combinedTests.observation.payload);
  assert.equal(verifyAttestation(combinedTests.observation, combinedTests.observation.publicKey), combinedTests.observation.publicKey);
  assert.deepEqual([proof.check, proof.sourceSha, proof.treeSha, proof.candidateSha, proof.mainSha, proof.state], ['combined-with-main', combinedB.sha, combinedB.treeSha, shaB, decisionA.mainSha, combinedB.state]);
  const failed = await call2('decide', { opId: 'combined-failing', task: 'table-shape', decider: 'luke', pick: 'finn', rationale: 'r', expectHeads: headsB }, 2);
  assert.equal(failed.error.code, 'combined_failing'); assert.match(failed.error.message, /3 tests fail combined with main/);
  // G edits the same parseRow line as A: Heddle reports the conflict in its own terms.
  const conflicted = (await mutate2('combine', { task: 'row-case', isolate: true })).candidates[0].combined;
  assert.equal(conflicted.status, 'conflict'); assert.equal(conflicted.sha, undefined);
  assert.deepEqual(conflicted.conflicts.map(c => [c.path, c.symbol]), [['src/table.mjs', 'parseRow']]);
  assert(conflicted.heddle.conflictCount >= 1); assert(conflicted.heddle.blockers.length >= 1);
  const conflictRejection = await call2('decide', { opId: 'combined-conflict', task: 'row-case', decider: 'luke', pick: 'gil', rationale: 'r', expectHeads: (await call2('candidates', { task: 'row-case' })).heads }, 2);
  assert.equal(conflictRejection.error.code, 'combined_conflict'); assert.match(conflictRejection.error.message, /src\/table\.mjs \(parseRow\)/);
  console.log(`Combined PASS: A and B each pass alone (B ${aloneB.passed}/${aloneB.passed}); after A lands Heddle merges B with main cleanly (${combinedB.heddle.mergeType}), the merged commit fails ${combinedTests.failed} tests (${combinedTests.failures.join('; ')}); signed observation bound to the combined SHA/tree; deciding B refused (pending, then failing); G conflicts with main in parseRow and is refused`);
  // Resolution: B's agent fast-forwards its fork to the combined commit (main + B, merged by Heddle),
  // fixes the failures and pushes. That head contains main, so its own tests are the combined result.
  const finn = checkouts.finn;
  await git(finn, ['fetch', '-q', canonical2, `refs/heads/combined/table-shape/finn/${combinedB.sha}`]);
  await git(finn, ['merge', '-q', '--ff-only', 'FETCH_HEAD']);
  const shaFixed = await edit('finn', { 'src/table.mjs': s => s.replace('return { header, rows };', 'const trim = row => row.map(cell => cell.trim());\n  return { header: trim(header), rows: rows.map(trim) };') }, 'Trim cells when reading a table');
  const revised = (await mutate2('ingest', { items: [item('finn', shaFixed)], runTests: true, isolateUnreviewed: true })).results[0].candidate;
  assert.equal(revised.combined, undefined, 'a head that contains main needs no separate combined check');
  assert.doesNotMatch((await call2('diff', { task: 'table-shape', agent: 'finn', maxBytes: 65536 })).diff, /return text\.split\("\|"\);/, 'the diff shows B\'s work, not main\'s');
  const fixedTests = (await mutate2('tests.record', { task: 'table-shape', agent: 'finn', sourceSha: shaFixed, run: await sandbox(canonical2, shaFixed, revised.treeSha) })).candidate.tests;
  assert.equal(fixedTests.status, 'pass'); assert.equal(fixedTests.passed, 6);
  const decisionB = await mutate2('decide', { task: 'table-shape', decider: 'luke', pick: 'finn', rationale: 'Merged main and trims where a table is read.', expectHeads: (await call2('candidates', { task: 'table-shape' })).heads });
  await mutate2('publish', { canonical: { remote: canonical2 } });
  assert.equal(await git(canonical2, ['rev-parse', 'main']), decisionB.mainSha);
  assert.equal(await git(canonical2, ['rev-parse', 'main^{tree}']), revised.treeSha, 'the landed tree is the tested merged head');
  assert.equal(await git(canonical2, ['rev-parse', 'main^']), decisionA.mainSha);
  assert.equal(decisionB.combined, undefined, 'a head that contains main lands as itself');
  console.log(`Combined resolution PASS: finn took the combined commit and fixed (${fixedTests.passed}/${fixedTests.passed} pass); its head contains main so no separate check; landed tree equals the tested head; main ${decisionB.mainSha.slice(0, 12)}`);
  // Both B (now on main) and H appended a function at the end of the same file. Plain Git reports a
  // conflict; Heddle merges the two functions cleanly, the merged result passes, and the human lands it.
  const gitMerge = await run('git', ['--git-dir', canonical2, 'merge-tree', '--write-tree', '--name-only', 'main', shaH], { allowFailure: true });
  assert.equal(gitMerge.code, 1, 'plain git merge conflicts'); assert.match(gitMerge.stdout.toString(), /src\/table\.mjs/);
  const combinedH = (await mutate2('combine', { task: 'column-count', isolate: true })).candidates[0].combined;
  assert.equal(combinedH.status, 'pending'); assert.equal(combinedH.heddle.conflictCount, 0, 'Heddle merges where git conflicts'); assert.deepEqual(combinedH.conflicts, []);
  const mergedH = await git(canonical2, ['show', `${combinedH.sha}:src/table.mjs`]);
  assert.match(mergedH, /export function readTable/); assert.match(mergedH, /export function columnCount/); assert.doesNotMatch(mergedH, /^[<>=]{7}/m);
  const passedH = (await mutate2('tests.record', { task: 'column-count', agent: 'hana', sourceSha: shaH, combined: { sha: combinedH.sha, mainSha: combinedH.mainSha }, run: await sandbox(canonical2, combinedH.sha, combinedH.treeSha) })).candidate.combined;
  assert.equal(passedH.status, 'pass'); assert.equal(passedH.tests.passed, 7);
  const decisionH = await mutate2('decide', { task: 'column-count', decider: 'luke', pick: 'hana', rationale: 'Heddle merged it with main and the merged result passes.', expectHeads: (await call2('candidates', { task: 'column-count' })).heads });
  assert.deepEqual(decisionH.combined, { sha: combinedH.sha, treeSha: combinedH.treeSha, mainSha: combinedH.mainSha, state: combinedH.state });
  const publishedH = await mutate2('publish', { canonical: { remote: canonical2 } });
  assert.deepEqual(publishedH.verify, { exportRoundTrip: true, treeMatch: true, fsck: true });
  assert.equal(await git(canonical2, ['rev-parse', 'main^{tree}']), combinedH.treeSha, 'main is exactly the tested combined tree');
  assert.equal(await git(canonical2, ['rev-parse', 'main^']), decisionB.mainSha);
  assert.match(await git(canonical2, ['log', '-1', '--format=%B', 'main']), new RegExp(`Heddle-Combined: ${combinedH.sha}`));
  assert.match((await call2('why', { sha: decisionH.mainSha })).narrative, /merged with main .* by Heddle; tested as/);
  console.log(`Native merge PASS: git merge-tree conflicts on src/table.mjs; Heddle merged hana with main cleanly (${combinedH.heddle.mergeType}, 0 conflicts); merged result ${passedH.tests.passed}/${passedH.tests.passed} pass; landed tree is the tested combined tree; publication verified`);
}

// ── A clean Heddle merge of two correct edits that is wrong ────────────────────────────────────
// A strips a leading pipe on line 2; B adds a line 3 that strips it too. Each is right alone. Git
// conflicts on the adjacent lines; Heddle merges them cleanly and calls the result ready, but the
// pipe is now stripped twice. Only tests on the merged state catch it, and landing is refused.
{
  const state3 = join(root, 'double-state'), canonical3 = join(root, 'double.git');
  let ops = 0;
  const call3 = (cmd, body = {}, expected = 0) => call(cmd, body, expected, state3);
  const mutate3 = (cmd, body) => call3(cmd, { opId: `double-${++ops}`, ...body });
  const seed3 = join(root, 'double-seed');
  const parser = '// SPDX-License-Identifier: Apache-2.0\nexport function parseRow(row) {\n  let text = row.trim();\n  if (text.endsWith("|")) text = text.slice(0, -1);\n  return text.split("|").map(cell => cell.trim());\n}\n';
  const files = { 'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }) + '\n', 'src/row.mjs': parser,
    'test/row.test.mjs': '// SPDX-License-Identifier: Apache-2.0\nimport { test } from "node:test"; import assert from "node:assert/strict";\nimport { parseRow } from "../src/row.mjs";\ntest("splits cells", () => assert.deepEqual(parseRow("a | b |"), ["a", "b"]));\n' };
  for (const [path, contents] of Object.entries(files)) { await mkdir(dirname(join(seed3, path)), { recursive: true }); await writeFile(join(seed3, path), contents); }
  await git(seed3, ['init', '-b', 'main']); await git(seed3, ['add', '.']);
  await git(seed3, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-m', 'Row parser seed']);
  await git(root, ['init', '--bare', '--initial-branch=main', canonical3]);
  await mutate3('init', { project: 'd', canonical: { remote: canonical3 }, seed: { importUrl: seed3 } });
  const lanes = { ana: 'leading-pipe-a', ben: 'leading-pipe-b' };
  for (const task of Object.values(lanes)) await mutate3('task.create', { task, intent: 'Accept an optional leading pipe' });
  for (const id of ['ana', 'ben', 'luke']) await mutate3('agent.enroll', { agent: { id, kind: id === 'luke' ? 'human' : 'agent', displayName: id } });
  const ownTest = name => `// SPDX-License-Identifier: Apache-2.0\nimport { test } from "node:test"; import assert from "node:assert/strict";\nimport { parseRow } from "../src/row.mjs";\ntest("${name}: strips one leading pipe", () => assert.deepEqual(parseRow("| a | b |"), ["a", "b"]));\ntest("${name}: keeps an empty first cell", () => assert.deepEqual(parseRow("|| a | b |"), ["", "a", "b"]));\n`;
  const changes = {
    ana: { 'src/row.mjs': parser.replace('let text = row.trim();', 'let text = row.trim().replace(/^\\|/, "");'), 'test/ana.test.mjs': ownTest('ana') },
    ben: { 'src/row.mjs': parser.replace('  let text = row.trim();\n', '  let text = row.trim();\n  if (text.startsWith("|")) text = text.slice(1);\n'), 'test/ben.test.mjs': ownTest('ben') },
  };
  const shas = {}, items = [];
  for (const [id, task] of Object.entries(lanes)) {
    const fork = join(root, `d--${task}--${id}.git`), co = join(root, `double-${id}`);
    await git(root, ['clone', '--bare', canonical3, fork]); await mutate3('lane.open', { task, agent: id }); await git(root, ['clone', fork, co]);
    for (const [path, contents] of Object.entries(changes[id])) await writeFile(join(co, path), contents);
    await git(co, ['add', '.']); await git(co, ['-c', `user.name=${id}`, '-c', `user.email=${id}@example.invalid`, 'commit', '-m', `${id}: accept a leading pipe`]); await git(co, ['push', 'origin', 'HEAD:main']);
    shas[id] = await git(co, ['rev-parse', 'HEAD']);
    items.push({ task, agent: id, fork: { remote: fork }, ref: 'refs/heads/main', sha: shas[id] });
  }
  const sandbox = async (sha, treeSha) => {
    const dir = await mkdtemp(join(root, 'sandbox-')), start = Date.now();
    await git(dir, ['init', '-q']); await git(dir, ['fetch', '-q', '--no-tags', '--depth=1', canonical3, sha]); await git(dir, ['checkout', '-q', '--detach', sha]);
    assert.equal(await git(dir, ['rev-parse', 'HEAD^{tree}']), treeSha);
    const tested = await run(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, allowFailure: true, env: { NO_COLOR: '1' } });
    return { sourceSha: sha, treeSha, output: tested.stdout.toString() + tested.stderr.toString(), durationMs: Date.now() - start, installExitCode: 0, testExitCode: tested.code };
  };
  const captured = await mutate3('ingest', { items, runTests: true, isolateUnreviewed: true });
  for (const { candidate } of captured.results) {
    const tests = (await mutate3('tests.record', { task: candidate.task, agent: candidate.agent, sourceSha: candidate.sourceSha, run: await sandbox(candidate.sourceSha, candidate.treeSha) })).candidate.tests;
    assert.equal(tests.status, 'pass', `${candidate.agent} is correct alone`); assert.equal(tests.passed, 3);
  }
  const decisionAna = await mutate3('decide', { task: 'leading-pipe-a', decider: 'luke', pick: 'ana', rationale: 'Strip the optional leading pipe.', expectHeads: (await call3('candidates', { task: 'leading-pipe-a' })).heads });
  await mutate3('publish', { canonical: { remote: canonical3 } });
  assert.equal((await run('git', ['--git-dir', canonical3, 'merge-tree', '--write-tree', 'main', shas.ben], { allowFailure: true })).code, 1, 'plain git merge conflicts on the adjacent lines');
  const combined = (await mutate3('combine', { task: 'leading-pipe-b', isolate: true })).candidates[0].combined;
  assert.equal(combined.heddle.conflictCount, 0); assert.equal(combined.heddle.status, 'ready'); assert.equal(combined.heddle.impact, 'none');
  const merged = await git(canonical3, ['show', `${combined.sha}:src/row.mjs`]);
  assert.match(merged, /replace\(\/\^\\\|\/, ""\);\n  if \(text\.startsWith\("\|"\)\) text = text\.slice\(1\);/, 'Heddle kept both edits: the pipe is stripped twice');
  const failed = (await mutate3('tests.record', { task: 'leading-pipe-b', agent: 'ben', sourceSha: shas.ben, combined: { sha: combined.sha, mainSha: decisionAna.mainSha }, run: await sandbox(combined.sha, combined.treeSha) })).candidate.combined;
  assert.equal(failed.status, 'fail'); assert.equal(failed.tests.failed, 2); assert.equal(failed.tests.passed, 3);
  assert.deepEqual([...failed.tests.failures].sort(), ['ana: keeps an empty first cell', 'ben: keeps an empty first cell']);
  const refused = await call3('decide', { opId: 'double-refused', task: 'leading-pipe-b', decider: 'luke', pick: 'ben', rationale: 'r', expectHeads: (await call3('candidates', { task: 'leading-pipe-b' })).heads }, 2);
  assert.equal(refused.error.code, 'combined_failing');
  console.log(`Silent merge break PASS: ana and ben each pass alone (3/3); git conflicts; Heddle merges cleanly and reports ${combined.heddle.status} (impact ${combined.heddle.impact}); the merged code strips the pipe twice and fails ${failed.tests.failed} tests (${failed.tests.failures.join('; ')}); landing ben is refused`);
}
