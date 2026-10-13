// SPDX-License-Identifier: Apache-2.0
// A real repository is seeded as one commit with its tip's exact tree, and a checkout of more files
// than Heddle's parallel threshold (32) completes instead of deadlocking.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, git } from '../lib/process.mjs';
import { fixedIdentity } from '../lib/git.mjs';

const engine = process.env.ENGINE_FILE || fileURLToPath(new URL('../engine.mjs', import.meta.url));
const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'track-b-import-snapshot-'));
const env = { ENGINE_STATE_DIR: join(root, 'state'), HEDDLE_BIN: process.env.HEDDLE_BIN || 'heddle', TMPDIR: process.env.TMPDIR || '/tmp' };
const call = async (cmd, body) => {
  // A deadlocked checkout never exits; fail fast instead of hanging the suite.
  const result = await run(process.execPath, [engine, cmd], { env, input: JSON.stringify(body), allowFailure: true, timeout: 90000 });
  assert.equal(result.code, 0, `${cmd}${result.timedOut ? ' timed out' : ''}: ${result.stdout} ${result.stderr}`);
  return JSON.parse(result.stdout);
};
const seed = join(root, 'seed'); await mkdir(seed);
await git(seed, ['init', '-b', 'main']);
for (let commit = 0; commit < 3; commit++) {
  for (let i = 0; i < 40; i++) {
    await mkdir(join(seed, `pkg${i % 7}`), { recursive: true });
    await writeFile(join(seed, `pkg${i % 7}`, `file${i}.ts`), `export const value${i} = ${commit};\n`);
  }
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', `Synthetic history ${commit}`], { env: fixedIdentity() });
}
const tip = await git(seed, ['rev-parse', 'HEAD']), tree = await git(seed, ['rev-parse', 'HEAD^{tree}']);
const canonical = join(root, 'fixture.git');
await git(root, ['init', '--bare', '--initial-branch=main', canonical]);
const started = Date.now();
const init = await call('init', { opId: 'init', project: 'fixture', canonical: { remote: canonical }, seed: { importUrl: `file://${seed}`, snapshot: true } });
assert.deepEqual(init.imported, { url: `file://${seed}`, sha: tip, tree });
assert.equal(await git(canonical, ['rev-parse', 'main']), init.mainSha);
assert.equal(await git(canonical, ['rev-parse', 'main^{tree}']), tree, 'the seed commit holds the source tip tree exactly');
assert.equal(await git(canonical, ['rev-list', '--count', 'main']), '1', 'history stays at the source');
assert.match(await git(canonical, ['log', '-1', '--format=%B', 'main']), new RegExp(`at ${tip}`));
// lane.open checks out all 40 files for the lane; on more than one thread Heddle 0.30 never returns.
await call('task.create', { opId: 'task', task: 'grow', intent: 'Exercise a large checkout' });
await call('agent.enroll', { opId: 'enroll', agent: { id: 'alice', kind: 'agent', displayName: 'Alice' } });
const fork = join(root, 'fixture--grow--alice.git');
await git(root, ['clone', '--bare', canonical, fork]);
await call('lane.open', { opId: 'lane', task: 'grow', agent: 'alice' });
console.log(`Import snapshot PASS: one commit with the source tree (${tree.slice(0, 12)}), 40-file checkouts complete (${((Date.now() - started) / 1000).toFixed(1)}s)`);
