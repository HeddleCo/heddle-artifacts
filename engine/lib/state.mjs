// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile, rename, appendFile, readdir, readlink, unlink, symlink, rm } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { run, Rejection } from './process.mjs';

export const stateRoot = process.env.ENGINE_STATE_DIR || '/state';
export const repoRoot = join(stateRoot, 'repo');
export const exportRoot = join(stateRoot, 'export.git');

export function requestHash(request) {
  // Preserve array order and exact values, but ignore JSON object key order.
  const canonical = JSON.stringify(request, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return createHash('sha256').update(canonical).digest('hex');
}

export async function load() {
  let state;
  try { state = JSON.parse(await readFile(join(stateRoot, 'engine.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { format: 1, generation: 0, root: stateRoot, turns: [] }; }
  for (const name of ['tasks', 'agents', 'lanes', 'operations', 'decisions', 'narratives', 'attestations', 'decisionAttestations', 'publicationRequests']) state[name] = Object.assign(Object.create(null), state[name] || {});
  return state;
}

export async function save(state, record) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  if (record) {
    state.generation++;
    state.operations[record.opId] = record;
    await appendFile(join(stateRoot, 'ops.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  }
  await writeFile(join(stateRoot, 'engine.json.tmp'), JSON.stringify(state) + '\n', { mode: 0o600 });
  await rename(join(stateRoot, 'engine.json.tmp'), join(stateRoot, 'engine.json'));
}

export async function identity(id) {
  const home = join(stateRoot, 'agents', id, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'device-identity.toml');
  try { return /public_key = "([a-f0-9]{64})"/.exec(await readFile(file, 'utf8'))[1]; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(file, `public_key = "${hex}"\nprivate_key_pem = '''${pem}'''\nserver = "local:heddle-artifacts"\nlinked_at = "${new Date().toISOString()}"\n`, { mode: 0o600 });
  return hex;
}

export function actorEnv(agent) {
  return {
    HEDDLE_HOME: join(stateRoot, 'agents', agent.id, 'home'),
    HEDDLE_CONFIG: join(stateRoot, 'agents', agent.id, 'home', 'config.toml'),
    HEDDLE_PRINCIPAL_NAME: agent.displayName || agent.id,
    HEDDLE_PRINCIPAL_EMAIL: `${agent.id}@heddle-artifacts.local`,
    HEDDLE_AGENT_PROVIDER: agent.provider || '', HEDDLE_AGENT_MODEL: agent.model || '',
    HEDDLE_FSMONITOR: 'off', NO_COLOR: '1',
    // Heddle 0.30.0 deadlocks when it writes 32 or more files to a worktree on more than one
    // thread (repository_materialization.rs), so a real repository's import or checkout never ends.
    HEDDLE_MATERIALIZE_THREADS: '1',
  };
}

export async function heddle(args, cwd = repoRoot, agent = { id: '_engine', displayName: 'Heddle engine' }, options = {}) {
  let result;
  try { result = await run(process.env.HEDDLE_BIN || 'heddle', ['--output', 'json', ...args], { cwd, ...options, env: { ...actorEnv(agent), ...options.env } }); }
  catch (error) { if (error.safeMessage) error.safeMessage = `${args.slice(0, 2).join(' ')}: ${error.safeMessage}`; throw error; }
  if (options.raw) return result;
  return JSON.parse(result.stdout);
}

export async function relocate(root, from, to) {
  // Stock Heddle persists checkout paths in JSON/TOML and pointer files.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await relocate(path, from, to);
    else if (entry.isFile() && entry.name.startsWith('catalog.sqlite3') && root.endsWith('/state/device-rpc') && from !== to) {
      // This derived local-discovery cache binds Spool IDs to absolute roots.
      // Stock native setup rebuilds it; copied bindings can target the old repo.
      await rm(path);
    }
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (target === from || target.startsWith(from + '/')) {
        await unlink(path); await symlink(to + target.slice(from.length), path);
      }
    }
    else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.toml') || ['objectstore', 'commondir', 'gitdir'].includes(entry.name))) {
      const text = await readFile(path, 'utf8');
      if (text.includes(from)) await writeFile(path, text.split(from).join(to));
    }
  }
}
