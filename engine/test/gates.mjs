// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile, readFile, mkdtemp, cp } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { run, git } from '../lib/process.mjs';
import { verifyCapture } from '../lib/signatures.mjs';
import { relocate } from '../lib/state.mjs';
import assert from 'node:assert/strict';
import { exportProjection } from '../lib/projection.mjs';

const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'track-b-gates-'));
const repo = join(root, 'repo');
await mkdir(repo);
const homes = {};
for (const id of ['engine', 'alice', 'bob', 'luke']) {
  const home = join(root, id);
  await mkdir(home, { mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(join(home, 'device-identity.toml'), `public_key = "${hex}"\nprivate_key_pem = '''${pem}'''\nserver = "local:heddle-artifacts"\nlinked_at = "2026-10-10T12:00:00Z"\n`, { mode: 0o600 });
  homes[id] = { home, hex };
}
const hh = async (args, cwd = repo, id = 'engine', allowFailure = false, extraEnv = {}) => {
  const r = await run(process.env.HEDDLE_BIN || '/home/scratch/heddle-0.30-bin/bin/heddle', ['--output', 'json', ...args], { cwd, env: { HEDDLE_HOME: homes[id].home, HEDDLE_PRINCIPAL_NAME: id, HEDDLE_PRINCIPAL_EMAIL: `${id}@local.invalid`, ...extraEnv }, allowFailure });
  let json; try { json = JSON.parse(r.stdout); } catch { json = { stdout: r.stdout.toString(), stderr: r.stderr.toString() }; }
  console.log(JSON.stringify({ command: ['heddle', ...args].join(' '), code: r.code, result: json }, (key, value) => key === 'token' ? '<redacted>' : value));
  return json;
};
console.log(`Gate scratch: ${root}`);
await hh(['init', '--no-harness-install']);
await writeFile(join(repo, 'table.txt'), 'base\n');
await hh(['capture', '-m', 'Seed']);
const shown = await hh(['show']);
console.log('G1 signature: ' + await verifyCapture(join(repo, '.heddle'), shown, homes.engine.hex));
const taskPath = join(root, 'task');
await hh(['start', 'task/parser', '--path', taskPath, '--workspace', 'solid', '--no-daemon']);
const fanout = await hh(['agent', 'fanout', 'start', '--title', 'Parser', '--lane', 'task/parser/alice=Alice', '--lane', 'task/parser/bob=Bob'], taskPath);
await writeFile(join(root, 'fanout.json'), JSON.stringify(fanout));
console.log('Fanout paths: ' + JSON.stringify(fanout.lanes));
const captures = {};
for (const lane of fanout.lanes) {
  const id = lane.thread.endsWith('alice') ? 'alice' : 'bob';
  const auto = JSON.parse(await readFile(join(lane.path, '.heddle', 'writer-credential.json')));
  await hh(['agent', 'release', '--lease', auto.lease], lane.path, id, false, { HEDDLE_RESERVATION_TOKEN: auto.token });
  const reserved = await hh(['agent', 'reserve', '--thread', lane.thread], lane.path, id);
  await writeFile(join(lane.path, 'table.txt'), `${id}\n`);
  await hh(['agent', 'capture', '--lease', reserved.reservation.lease_id, '-m', `${id} edit`], lane.path, id, false, { HEDDLE_RESERVATION_TOKEN: reserved.token });
  captures[id] = await hh(['show'], lane.path, id);
  console.log(`G1 ${id} native signature: ` + await verifyCapture(join(repo, '.heddle'), captures[id], homes[id].hex));
}
await cp(repo, join(root, 'before-preview'), { recursive: true, verbatimSymlinks: true });
await hh(['thread', 'absorb', 'task/parser/alice', '--into', 'task/parser'], taskPath, 'luke', true);
await hh(['thread', 'absorb', 'task/parser/bob', '--into', 'task/parser'], taskPath, 'luke', true);
await hh(['resolve', '--heads'], taskPath, 'luke', true);
await hh(['resolve', '--pick', captures.bob.state_id_full], taskPath, 'luke', true);
console.log('Gates inspectable scratch: ' + root);

const seed = join(root, 'g3-seed'), g3 = join(root, 'g3-repo'), task3 = join(root, 'g3-task'), lane3 = join(root, 'g3-bob');
await mkdir(seed); await mkdir(g3);
await git(seed, ['init', '-b', 'main']);
await git(seed, ['config', 'user.name', 'Seed']); await git(seed, ['config', 'user.email', 'seed@local.invalid']);
await writeFile(join(seed, 'table.txt'), 'base\n'); await git(seed, ['add', '.']); await git(seed, ['commit', '-m', 'Seed main']);
await hh(['init', '--no-harness-install'], g3);
await hh(['bridge', 'git', 'import', '--path', seed, '--ref', 'main'], g3);
await hh(['thread', 'switch', 'main'], g3);
await hh(['start', 'task/g3', '--path', task3, '--workspace', 'solid', '--no-daemon'], g3);
await hh(['start', 'task/g3/bob', '--path', lane3, '--workspace', 'solid', '--no-daemon', '--parent-thread', 'task/g3'], task3, 'bob');
const lease3 = await hh(['agent', 'reserve', '--thread', 'task/g3/bob'], lane3, 'bob');
await writeFile(join(lane3, 'table.txt'), 'bob\n');
await hh(['agent', 'capture', '--lease', lease3.reservation.lease_id, '-m', 'Bob'], lane3, 'bob', false, { HEDDLE_RESERVATION_TOKEN: lease3.token });
await hh(['thread', 'absorb', 'task/g3/bob', '--into', 'task/g3', '-m', 'Chosen: bob'], task3, 'luke');
await hh(['land', '--thread', 'task/g3', '-m', 'Chosen: bob\nHeddle-Task: g3'], task3, 'luke');
const export1 = join(root, 'g3-export.git');
await hh(['bridge', 'git', 'export', '--destination', export1], g3, 'engine', true);
const land3 = await hh(['show', 'main'], g3);
const rawMessage = await git(export1, ['show', '-s', '--format=%B', 'main']);
const projection = { parentSha: await git(seed, ['rev-parse', 'main']), treeSha: await git(export1, ['rev-parse', 'main^{tree}']), author: 'luke', email: 'luke@local.invalid', at: land3.created_at,
  message: `Chosen: bob\nHeddle-Task: g3\n\nHeddle-State: ${land3.state_id_full}\nHeddle-Change: ${/Heddle-Change: (\S+)/.exec(rawMessage)[1]}` };
const sha1 = (await exportProjection({ projection }, export1, g3)).sha;
const archive = join(root, 'g3.tar.zst'), restored = join(root, 'g3-restored', 'repo');
await run('tar', ['--zstd', '-cf', archive, '-C', g3, '.']);
await mkdir(restored, { recursive: true });
await run('tar', ['--zstd', '-xf', archive, '-C', restored]);
await relocate(restored, g3, restored);
const export2 = join(root, 'g3-restored-export.git');
await git(root, ['clone', '--bare', export1, export2]);
const sha2 = (await exportProjection({ projection }, export2, restored)).sha;
assert.equal(sha2, sha1, 'G3 export must be reproducible from a restored native repository');
assert.match(await git(export2, ['log', '-1', '--format=%B', 'main']), /Heddle-State:/);
await git(export2, ['rev-parse', 'refs/notes/heddle']);
console.log(`G3 FALLBACK PASS: original ${sha1}; restored ${sha2}; native notes and trailers present`);
const unpinned = await exportProjection({}, export2, restored);
assert.notEqual(unpinned.sha, sha1, 'G3 negative: skipping the export pin must change the projection');
console.log(`G3 negative PASS: skip export pin gives ${unpinned.sha}, differs from ${sha1}`);
