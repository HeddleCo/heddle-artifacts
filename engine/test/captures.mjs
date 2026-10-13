// SPDX-License-Identifier: Apache-2.0
// Runs locally with HEDDLE_BIN and in the engine image via e2e.sh.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/process.mjs';

test('capture history reads every stored push, bounds work, caches across restore, isolates unavailable pairs and retries timeouts', async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'heddle-captures-'));
  const stateDir = join(root, 'state'), repo = join(stateDir, 'repo'), home = join(root, 'home');
  await mkdir(repo, { recursive: true }); await mkdir(home);
  const binary = process.env.HEDDLE_BIN || 'heddle';
  const env = { ENGINE_STATE_DIR: stateDir, HEDDLE_BIN: binary, HOME: home, HEDDLE_HOME: home, HEDDLE_FSMONITOR: 'off' };
  const h = async args => JSON.parse((await run(binary, ['--output', 'json', ...args], { cwd: repo, env })).stdout);
  const engine = process.env.ENGINE_FILE || fileURLToPath(new URL('../engine.mjs', import.meta.url));
  const call = async (command, body = {}, overrides = {}) => {
    const output = await run(process.execPath, [engine, command], { env: { ...env, ...overrides }, input: JSON.stringify(body), allowFailure: true });
    assert.equal(output.code, 0, `${command}: ${output.stdout} ${output.stderr}`);
    return JSON.parse(output.stdout);
  };
  try {
    await h(['init', '--principal-name', 'Capture test', '--principal-email', 'capture@example.invalid', '--no-harness-install']);
    await writeFile(join(repo, 'table.ts'), 'export function parseRow(row: string) {\n  return row.split("|");\n}\n');
    await h(['capture', '-m', 'base']); const base = (await h(['show'])).state_id_full;
    const ids = [];
    for (let i = 1; i <= 4; i++) {
      await writeFile(join(repo, 'table.ts'), `export function parseRow(row: string) {\n  return row.trim().split("|").slice(0, ${i});\n}\n`);
      await h(['capture', '-m', `push ${i}`]); ids.push((await h(['show'])).state_id_full);
    }
    assert.ok(ids.every(s => s.startsWith('hs-')));
    const candidate = (i, agent = 'alice', state = ids[i - 1]) => ({ task: 'table', agent, state, sourceSha: String(i).repeat(40), treeSha: 'b'.repeat(40), parentSha: '0'.repeat(40), subject: `push ${i}`, diffstat: { files: 1, insertions: 2, deletions: 1 }, tests: { status: 'pass', passed: 1, failed: 0, summary: 'passed', durationMs: 1 }, conflicts: [], signedBy: 'a'.repeat(64), capturedAt: `2026-10-10T12:00:0${i}Z` });
    const first = candidate(1), second = candidate(2), third = candidate(3);
    const manifest = { format: 1, generation: 5, root: stateDir, project: 'test', tasks: { table: { baseState: base, baseSha: '0'.repeat(40) } }, agents: { alice: { kind: 'agent' }, bob: { kind: 'agent' }, reviewer: { kind: 'reviewer' } }, lanes: {
      'table/alice': { task: 'table', agent: 'alice', candidate: third, seen: { [third.sourceSha]: third, [first.sourceSha]: first, [second.sourceSha]: second } },
      'table/bob': { task: 'table', agent: 'bob', seen: { [first.sourceSha]: { ...first, agent: 'bob' } } },
      'table/reviewer': { task: 'table', agent: 'reviewer', seen: { [third.sourceSha]: { ...third, agent: 'reviewer' } } }
    } };
    await writeFile(join(stateDir, 'engine.json'), JSON.stringify(manifest));
    const history = await call('captures', { task: 'table' });
    assert.deepEqual(history.lanes.map(l => l.agent), ['alice', 'bob']);
    assert.deepEqual(history.lanes[0].captures.map(c => c.sourceSha), [first.sourceSha, second.sourceSha, third.sourceSha], 'all three pushes, not just the latest candidate');
    assert.deepEqual(history.lanes[0].captures.map(c => c.fromState), [base, ids[0], ids[1]]);
    assert.deepEqual(history.lanes[0].captures.map(c => c.semantic.status), ['ready', 'pending', 'pending']);
    assert.equal(history.lanes[1].captures[0].semantic.status, 'ready', 'same pair reuses the cache across lanes');
    assert.equal(history.pending, 2); assert.equal(history.cacheChanged, true);
    assert.deepEqual(history.lanes[0].captures[0].semantic.changes, (await h(['diff', base, ids[0], '--semantic'])).semantic_changes);
    assert.ok(history.lanes[0].captures[0].semantic.changes.some(c => c.change_type === 'function_modified' && c.old_name === 'parseRow'));
    assert.equal(Object.keys(JSON.parse(await readFile(join(stateDir, 'engine.json'))).semanticDiffs).length, 1);
    assert.equal((await call('captures', { task: 'table' })).pending, 1);
    assert.equal((await call('captures', { task: 'table' })).pending, 0);
    const snap = await run(process.execPath, [engine, 'snapshot'], { env, input: '{}', maxBytes: 256 * 1024 * 1024 });
    const restored = await run(process.execPath, [engine, 'restore'], { env, input: snap.stdout });
    assert.equal(restored.code, 0);
    const cached = await call('captures', { task: 'table' }, { HEDDLE_BIN: '/missing-heddle' });
    assert.equal(cached.cacheChanged, false); assert.equal(cached.pending, 0);
    assert.deepEqual(cached.lanes[0].captures.map(c => c.semantic.status), ['ready', 'ready', 'ready'], 'cached results survive a real snapshot restore without Heddle');
    const broken = JSON.parse(await readFile(join(stateDir, 'engine.json')));
    const fourth = candidate(4, 'alice', 'hs-missing'); broken.lanes['table/alice'].seen[fourth.sourceSha] = fourth;
    await writeFile(join(stateDir, 'engine.json'), JSON.stringify(broken));
    const unavailable = await call('captures', { task: 'table' });
    assert.equal(unavailable.lanes[0].captures[3].semantic.status, 'unavailable');
    assert.equal(unavailable.lanes[0].captures[0].semantic.status, 'ready');
    assert.equal((await call('captures', { task: 'table' }, { HEDDLE_BIN: '/missing-heddle' })).cacheChanged, false, 'unavailable is cached too');
    // Timeouts: a stalled Heddle is killed at the (test-shortened) deadline, the pair stays pending with an attempt
    // count, a later read retries it, and only the third timed-out attempt caches unavailable.
    const waitingBinary = join(root, 'waiting-heddle');
    await writeFile(waitingBinary, '#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n'); await chmod(waitingBinary, 0o700);
    const stalled = { HEDDLE_BIN: waitingBinary, ENGINE_SEMANTIC_TIMEOUT_MS: '300' };
    const timed = JSON.parse(await readFile(join(stateDir, 'engine.json'))), fifth = candidate(5, 'alice', 'hs-timeout'), bobSecond = { ...candidate(6, 'bob', ids[3]), agent: 'bob' };
    timed.lanes['table/alice'].seen[fifth.sourceSha] = fifth; timed.lanes['table/bob'].seen[bobSecond.sourceSha] = bobSecond;
    await writeFile(join(stateDir, 'engine.json'), JSON.stringify(timed));
    const fifthKey = JSON.stringify(['hs-missing', 'hs-timeout']), bobKey = JSON.stringify([ids[0], ids[3]]);
    const cache = async () => JSON.parse(await readFile(join(stateDir, 'engine.json'))).semanticDiffs;
    for (const attempt of [1, 2]) {
      const started = performance.now(), read = await call('captures', { task: 'table' }, stalled);
      assert.ok(performance.now() - started < 5000, 'a stalled semantic subprocess must release the serial queue');
      assert.deepEqual(read.lanes[0].captures[4].semantic, { status: 'pending' }, `timeout ${attempt} is retried, not cached as unavailable`);
      assert.deepEqual(read.lanes[1].captures[1].semantic, { status: 'pending' });
      assert.equal(read.pending, 2); assert.equal(read.cacheChanged, true, 'the attempt count is durable state');
      assert.deepEqual((await cache())[fifthKey], { status: 'pending', timeouts: attempt });
      assert.equal((await cache())[bobKey], undefined, 'a retried timeout still uses the one uncached pair per read');
    }
    const exhausted = await call('captures', { task: 'table' }, stalled);
    assert.deepEqual(exhausted.lanes[0].captures[4].semantic, { status: 'unavailable' }, 'the third timed-out attempt is final');
    assert.deepEqual((await cache())[fifthKey], { status: 'unavailable' });
    assert.equal(exhausted.pending, 1); assert.equal((await cache())[bobKey], undefined);
    const bobTimedOut = await call('captures', { task: 'table' }, stalled);
    assert.deepEqual(bobTimedOut.lanes[1].captures[1].semantic, { status: 'pending' });
    assert.deepEqual((await cache())[bobKey], { status: 'pending', timeouts: 1 });
    const retried = await call('captures', { task: 'table' });
    assert.equal(retried.lanes[1].captures[1].semantic.status, 'ready', 'a later read retries a timed-out pair with Heddle');
    assert.deepEqual(retried.lanes[1].captures[1].semantic.changes, (await h(['diff', ids[0], ids[3], '--semantic'])).semantic_changes);
    assert.equal(retried.pending, 0); assert.equal(retried.cacheChanged, true);
    const settled = await call('captures', { task: 'table' }, { HEDDLE_BIN: '/missing-heddle' });
    assert.equal(settled.cacheChanged, false); assert.equal(settled.pending, 0);
    assert.deepEqual(settled.lanes[0].captures.map(c => c.semantic.status), ['ready', 'ready', 'ready', 'unavailable', 'unavailable']);
    console.log('Captures PASS: 3 stored pushes ordered, previous/base pairs, 1 uncached pair per call, shared cache, real snapshot restore, Heddle errors cached unavailable, timeouts retried (2 pending attempts, 3rd final), timed-out pair later ready');
  } finally { await rm(root, { recursive: true, force: true }); }
});
