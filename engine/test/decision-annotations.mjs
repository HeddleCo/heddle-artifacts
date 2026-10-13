// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, git } from '../lib/process.mjs';

const anchoredOnly = process.argv.includes('--anchored-only');
const root = await mkdtemp(join(tmpdir(), 'decision-annotations-'));
const binary = process.env.HEDDLE_BIN || 'heddle';
const engine = process.env.ENGINE_FILE || fileURLToPath(new URL('../engine.mjs', import.meta.url));
const state = join(root, 'state'), seed = join(root, 'seed'), canonical = join(root, 'fixture.git');
// run() intentionally restricts inherited env. Isolate the real CLI's HOME as well as HEDDLE_HOME.
const wrapper = join(root, 'heddle');
await writeFile(wrapper, '#!/bin/sh\nexport HOME="$HEDDLE_HOME"\nexec ' + "'" + binary.replaceAll("'", "'\\''") + "'" + ' "$@"\n', { mode: 0o700 });
const env = { ENGINE_STATE_DIR: state, HEDDLE_BIN: wrapper, TMPDIR: root, HOME: join(root, 'home') };
let operation = 0;
async function call(command, input = {}, expected = 0) {
  const result = await run(process.execPath, [engine, command], { input: JSON.stringify(input), env, allowFailure: true });
  assert.equal(result.code, expected, `${command}: ${result.stdout} ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const mutate = (command, input) => call(command, { opId: `decision-${++operation}`, ...input });
const actor = { HOME: join(state, 'agents', 'human', 'home'), HEDDLE_HOME: join(state, 'agents', 'human', 'home'), HEDDLE_PRINCIPAL_NAME: 'Human', HEDDLE_PRINCIPAL_EMAIL: 'human@heddle-artifacts.local' };
async function native(args, cwd = join(state, 'repo'), expected = 0) {
  const result = await run(binary, ['--output', 'json', ...args], { cwd, env: actor, allowFailure: true });
  assert.equal(result.code, expected, `${args.join(' ')}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
try {
  console.log((await run(binary, ['--version'])).stdout.toString().trim());
  await mkdir(join(seed, 'src'), { recursive: true });
  await writeFile(join(seed, 'gone.txt'), 'This file will be deleted by the chosen candidate.\n');
  await writeFile(join(seed, 'README.md'), '# An unrelated first base file\n');
  await writeFile(join(seed, 'src/table.ts'), 'export function parseRow(row: string) { return row.split("|"); }\n');
  await git(seed, ['init', '-b', 'main']);
  await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-m', 'Seed']);
  await git(root, ['init', '--bare', '--initial-branch=main', canonical]);
  await mutate('init', { project: 'fixture', canonical: { remote: canonical }, seed: { importUrl: seed } });
  await mutate('agent.enroll', { agent: { id: 'human', kind: 'human', displayName: 'Human' } });
  await mutate('agent.enroll', { agent: { id: 'picked', kind: 'agent', displayName: 'Picked' } });
  async function candidate(task) {
    await mutate('task.create', { task, intent: 'Change the parser' });
    const fork = join(root, `fixture--${task}--picked.git`), checkout = join(root, task);
    await git(root, ['clone', '--bare', canonical, fork]);
    await mutate('lane.open', { task, agent: 'picked' });
    await git(root, ['clone', fork, checkout]);
    await writeFile(join(checkout, 'src/table.ts'), `export function parseRow(row: string) { return row.trim().split("|"); }\n// ${task}\n`);
    if (task === 'anchored') {
      await rm(join(checkout, 'gone.txt'));
      await writeFile(join(checkout, 'src/new.ts'), 'export function newSymbol() { return true; }\n');
    }
    await git(checkout, ['add', '.']);
    await git(checkout, ['-c', 'user.name=Picked', '-c', 'user.email=picked@example.invalid', 'commit', '-m', 'Change parser']);
    const sha = await git(checkout, ['rev-parse', 'HEAD']);
    await git(checkout, ['push', 'origin', 'HEAD:main']);
    await mutate('ingest', { items: [{ task, agent: 'picked', fork: { remote: fork }, ref: 'refs/heads/main', sha }], runTests: false });
    return { task, pick: 'picked', decider: 'human', expectHeads: (await call('candidates', { task })).heads };
  }
  const chosen = await candidate('anchored');
  const beforeState = await readFile(join(state, 'engine.json'));
  const beforeNative = (await native(['show', 'task/anchored'])).state_id_full;
  if (!anchoredOnly) for (const invalid of [{ anchor: 'gone.txt' }, { anchor: 'missing.ts:parseRow' }, { anchor: 'src' }, { anchor: '../src/table.ts' }, { anchor: 'src/table.ts:bad-name' }, { tags: ['bad tag'] }, { tags: Array(9).fill('x') }]) {
    const result = await call('decide', { opId: `invalid-${++operation}`, ...chosen, rationale: 'Invalid decision', ...invalid }, 2);
    assert.match(result.error.code, /^invalid_(anchor|tags)$/);
    assert.deepEqual(await readFile(join(state, 'engine.json')), beforeState, 'invalid decisions do not mutate engine state');
    assert.equal((await native(['show', 'task/anchored'])).state_id_full, beforeNative, 'invalid decisions do not absorb the lane');
  }
  if (!anchoredOnly) console.log('PASS invalid anchors/tags rejected before native or stored decision changes');
  if (!anchoredOnly) {
    assert.deepEqual(await call('decision.validate', { task: chosen.task, pick: chosen.pick, anchor: 'src/new.ts:newSymbol' }), { valid: true });
    console.log('PASS chosen tree validation accepts a newly added file and rejects a deleted base file');
  }
  const rationale = 'Whitespace belongs to parseRow.';
  const decision = await mutate('decide', { ...chosen, rationale, anchor: 'src/table.ts:parseRow', tags: ['parseRow', 'whitespace'] });
  const context = await native(['context', 'get', '--path', 'src/table.ts', '--symbol', 'parseRow']);
  const annotation = context.annotations.find(a => a.content === rationale);
  assert.ok(annotation, 'anchored rationale annotation exists at src/table.ts:parseRow');
  assert.equal(annotation.scope, 'symbol:parseRow', 'anchored annotation has symbol scope');
  assert.deepEqual(annotation.tags, ['parseRow', 'whitespace'], 'anchored annotation keeps the decision tags');
  assert.equal(decision.anchor, 'src/table.ts:parseRow');
  assert.deepEqual(decision.tags, ['parseRow', 'whitespace']);
  console.log(`PASS anchored decision: ${JSON.stringify({ scope: annotation.scope, tags: annotation.tags })}`);
  if (!anchoredOnly) {
    await mutate('publish', { canonical: { remote: canonical } });
    const next = await candidate('default');
    const opened = JSON.parse(await readFile(join(state, 'engine.json'))).lanes['default/picked'].briefing;
    assert.ok(opened.annotations.some(a => a.scope === 'symbol:parseRow' && a.tags.join(',') === 'parseRow,whitespace'), 'later lane briefing retains scope and tags');
    console.log('PASS later lane briefing keeps symbol scope and tags');
    const unanchored = await mutate('decide', { ...next, rationale: 'Default belongs on the changed parser.', tags: ['-whitespace'] });
    const discussions = await native(['discuss', 'list', '--status', 'all']);
    const discussion = discussions.discussions.find(d => d.turns.some(t => t.body === unanchored.rationale));
    assert.equal(discussion.anchor.path, 'src/table.ts', 'default uses chosen candidate changed file instead of README.md');
    assert.equal(unanchored.anchor, 'src/table.ts');
    console.log('PASS no-anchor default: src/table.ts (chosen changed file), not README.md');
    const fileContext = await native(['context', 'get', '--path', 'src/table.ts']);
    assert.deepEqual(fileContext.annotations.find(a => a.content === unanchored.rationale).tags, ['-whitespace']);
    console.log('PASS allowed leading-hyphen tag: -whitespace');
    // Native Heddle accepts a syntactically valid symbol even when absent; this is not symbol resolution.
    const probe = await native(['discuss', 'new', '--path', 'src/table.ts', '--symbol', 'missingSymbol', '--body', 'Missing symbol probe']);
    assert.equal(probe.discussion.anchor.symbol, 'missingSymbol');
    console.log('PASS Heddle 0.31.1 absent symbol probe: accepted symbol:missingSymbol');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
