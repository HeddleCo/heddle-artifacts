// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm, cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { run, Rejection } from './process.mjs';
import { stateRoot, load, relocate } from './state.mjs';

const LOADED = '.loaded';
/** The token of the restore this container's state came from, or null after a container restart. */
export async function loadedToken() {
  try { const token = (await readFile(join(stateRoot, LOADED), 'utf8')).trim(); return /^[0-9a-f-]{36}$/.test(token) ? token : null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function snapshot(output = process.stdout) {
  const state = await load();
  if (!state.project) throw new Rejection('not_initialized', 'Initialize the project before snapshot');
  const child = spawn('tar', ['--zstd', '--exclude=node_modules', `--exclude=./${LOADED}`, '-cf', '-', '-C', stateRoot, '.'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const completion = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Snapshot tar failed'))); });
  await Promise.all([pipeline(child.stdout, output, { end: false }), completion]);
}

export async function restore(input) {
  const temp = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'heddle-restore-'));
  try {
    const archive = join(temp, 'state.tar.zst');
    await writeFile(archive, input, { mode: 0o600 });
    const listing = (await run('tar', ['--zstd', '-tf', archive])).stdout.toString().split('\n').filter(Boolean);
    if (listing.some(path => path.startsWith('/') || path.split('/').includes('..'))) throw new Rejection('invalid_snapshot', 'Snapshot paths must stay within state');
    const staged = join(temp, 'state');
    await mkdir(staged, { mode: 0o700 });
    await run('tar', ['--zstd', '--no-same-owner', '-xf', archive, '-C', staged]);
    let state = JSON.parse(await readFile(join(staged, 'engine.json'), 'utf8'));
    if (state.format !== 1 || !state.project || !Number.isSafeInteger(state.generation)) throw new Rejection('invalid_snapshot', 'Unsupported snapshot manifest');
    await relocate(staged, state.root, stateRoot);
    state = JSON.parse(await readFile(join(staged, 'engine.json'), 'utf8'));
    state.root = stateRoot;
    await writeFile(join(staged, 'engine.json'), JSON.stringify(state) + '\n', { mode: 0o600 });
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    // Restore happens before the ProjectDO schedules another operation.
    for (const name of await readdir(stateRoot)) await rm(join(stateRoot, name), { recursive: true, force: true });
    for (const name of await readdir(staged)) await cp(join(staged, name), join(stateRoot, name), { recursive: true, verbatimSymlinks: true });
    // A fresh token marks exactly this restore. The Worker skips its next restore only while the
    // container still holds this token; a restarted container has none, and no snapshot carries it.
    const token = randomUUID();
    await writeFile(join(stateRoot, LOADED), token, { mode: 0o600 });
    return { generation: state.generation, loaded: token };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
