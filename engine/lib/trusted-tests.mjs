// SPDX-License-Identifier: Apache-2.0
// This is a fail-closed public-fixture allowlist, NOT an untrusted-code sandbox.
// The image/operator owns the manifest. Never generate it from an incoming tree.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, open, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const defaultManifest = fileURLToPath(new URL('../../demo/trusted-test-trees.json', import.meta.url));
const MAX_ENTRIES = 256, MAX_FILE = 2 * 1024 * 1024, MAX_TREE = 8 * 1024 * 1024;
const forbidden = new Set(['.git', '.heddle', 'node_modules', '.npmrc']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = entries => [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const treeDigest = entries => sha256(JSON.stringify(sorted(entries)));
const within = (parent, child) => { const rel = relative(parent, child); return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
class Withheld extends Error {}
function check(condition, reason) { if (!condition) throw new Withheld(reason); }
function safePath(path) {
  check(typeof path === 'string' && path.length <= 512 && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path), 'unsafe source path');
  const parts = path.split('/');
  check(parts.length <= 12 && parts.every(part => part && part !== '.' && part !== '..' && !forbidden.has(part)), 'forbidden or unsafe source path');
}
function safeMode(stat, directory = false) {
  check(!(stat.mode & 0o7022), 'unsafe source permissions');
  check(directory ? stat.isDirectory() : stat.isFile(), 'symlinks and special files are not permitted');
  if (!directory) check(stat.nlink === 1, 'hard-linked source files are not permitted');
}
function stable(a, b) { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
async function readRegular(path, expected, limit) {
  safeMode(expected);
  check(expected.size <= limit, 'source or manifest exceeds the size limit');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check(stable(expected, await handle.stat()), 'file changed during verification');
    // A concurrently growing file must not turn verification into an unbounded
    // read. Read at most the already-bounded expected length plus one byte.
    const buffer = Buffer.alloc(expected.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    check(bytes.length <= limit && stable(expected, await handle.stat()), 'file changed during verification');
    check(stable(expected, await lstat(path)), 'file changed during verification');
    return bytes;
  } finally { await handle.close(); }
}

// Test/demo tooling supplies explicit, reviewed bytes, never a directory to scan.
// Updating this output is a new operator review, not an automatic trust decision.
export function createReviewedFixtureEntry(name, sourceFiles) {
  check(typeof name === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(name), 'invalid reviewed fixture name');
  const entries = [], dirs = new Set();
  let total = 0;
  for (const [path, value] of Object.entries(sourceFiles)) {
    safePath(path);
    const explicit = typeof value === 'object' && !Buffer.isBuffer(value) ? value : { contents: value };
    check(typeof explicit.contents === 'string' || Buffer.isBuffer(explicit.contents), 'reviewed fixture requires explicit source bytes');
    const bytes = Buffer.from(explicit.contents);
    total += bytes.length;
    check(bytes.length <= MAX_FILE && total <= MAX_TREE, 'reviewed fixture exceeds size limit');
    entries.push({ path, type: 'file', mode: explicit.executable ? '100755' : '100644', bytes: bytes.length, sha256: sha256(bytes) });
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const path of dirs) entries.push({ path, type: 'directory' });
  check(entries.length > 0 && entries.length <= MAX_ENTRIES && new Set(entries.map(e => e.path)).size === entries.length, 'invalid reviewed fixture tree');
  const ordered = sorted(entries);
  return { name, sha256: treeDigest(ordered), entries: ordered };
}

async function readManifest(candidateRoot) {
  // This setting comes only from the operator process environment, never requests.
  const selected = process.env.HEDDLE_TRUSTED_TEST_MANIFEST || defaultManifest;
  check(isAbsolute(selected), 'trusted manifest must use an absolute operator path');
  const path = await realpath(selected);
  check(path === resolve(selected), 'trusted manifest path may not contain symlinks');
  check(!within(candidateRoot, path), 'trusted manifest cannot be inside the candidate tree');
  const state = resolve(process.env.ENGINE_STATE_DIR || '/state');
  check(!within(state, path), 'trusted manifest cannot be inside engine state');
  // Root/image ownership or this operator's ownership; no writable parent aliases.
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const stat = await lstat(parent);
    check(stat.isDirectory() && (stat.uid === 0 || stat.uid === process.getuid?.()), 'untrusted manifest directory owner');
    check(!(stat.mode & 0o022) || !!(stat.mode & 0o1000), 'trusted manifest parent is writable by others');
    if (parent === dirname(parent)) break;
  }
  const stat = await lstat(path);
  check(stat.uid === 0 || stat.uid === process.getuid?.(), 'untrusted manifest owner');
  const manifest = JSON.parse(await readRegular(path, stat, MAX_FILE));
  check(manifest.version === 1 && Array.isArray(manifest.trees) && manifest.trees.length > 0 && manifest.trees.length <= 64, 'invalid trusted manifest');
  for (const tree of manifest.trees) {
    check(typeof tree.name === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(tree.name) && Array.isArray(tree.entries) && tree.entries.length > 0 && tree.entries.length <= MAX_ENTRIES, 'invalid trusted manifest tree');
    const seen = new Set();
    let total = 0;
    for (const entry of tree.entries) {
      safePath(entry.path);
      check(!seen.has(entry.path), 'duplicate trusted manifest path'); seen.add(entry.path);
      if (entry.type === 'file') {
        check(['100644', '100755'].includes(entry.mode) && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAX_FILE, 'invalid trusted manifest file');
        total += entry.bytes;
      } else check(entry.type === 'directory', 'invalid trusted manifest entry');
    }
    check(total <= MAX_TREE && tree.sha256 === treeDigest(tree.entries), 'trusted manifest digest mismatch');
  }
  return manifest;
}

async function verifiedSnapshot(cwd) {
  const root = await realpath(cwd);
  check(root === resolve(cwd), 'candidate root may not contain symlinks');
  safeMode(await lstat(root), true);
  const manifest = await readManifest(root);
  const entries = [], files = new Map();
  let total = 0;
  async function walk(directory, prefix = '') {
    const before = await lstat(directory); safeMode(before, true);
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(directory, name), stat = await lstat(full);
      // materialize() rejects incoming .heddle anywhere. Only native root metadata
      // is omitted, never traversed or copied into the execution directory.
      if (path === '.heddle') { safeMode(stat, true); continue; }
      safePath(path);
      check(entries.length < MAX_ENTRIES, 'candidate tree exceeds entry limit');
      if (stat.isDirectory()) {
        safeMode(stat, true); entries.push({ path, type: 'directory' }); await walk(full, path);
      } else {
        const bytes = await readRegular(full, stat, MAX_FILE);
        total += bytes.length; check(total <= MAX_TREE, 'candidate tree exceeds size limit');
        entries.push({ path, type: 'file', mode: stat.mode & 0o111 ? '100755' : '100644', bytes: bytes.length, sha256: sha256(bytes) });
        files.set(path, bytes);
      }
    }
    check(stable(before, await lstat(directory)), 'directory changed during verification');
  }
  await walk(root);
  const digest = treeDigest(entries);
  const fixture = manifest.trees.find(tree => tree.sha256 === digest && JSON.stringify(sorted(tree.entries)) === JSON.stringify(sorted(entries)));
  check(fixture, 'complete source tree is not in the operator-reviewed SHA-256 allowlist');
  return { root, fixture: fixture.name, sha256: digest, entries, files };
}

function reason(error) { return error instanceof Withheld ? error.message : 'trusted manifest or source tree could not be safely verified'; }
export async function authorizeCandidateTree(cwd) {
  try { const { fixture, sha256 } = await verifiedSnapshot(cwd); return { authorized: true, fixture, sha256 }; }
  catch (error) { return { authorized: false, reason: reason(error) }; }
}

export async function prepareReviewedFixture(cwd) {
  let temporary;
  try {
    const verified = await verifiedSnapshot(cwd);
    const base = await realpath(tmpdir());
    check(!within(verified.root, base), 'execution temporary directory cannot be candidate-controlled');
    // Reuse only an operator-owned npm content cache, never node_modules. npm ci
    // checks each tarball against the already-reviewed lockfile integrity. This
    // allows an operator to prewarm installs without forwarding proxy secrets.
    const npmCache = join(base, 'heddle-npm-cache');
    check(!within(verified.root, npmCache), 'npm cache cannot be inside the candidate tree');
    check(!within(resolve(process.env.ENGINE_STATE_DIR || '/state'), npmCache), 'npm cache cannot be inside engine state');
    await mkdir(npmCache, { recursive: true, mode: 0o700 });
    check(await realpath(npmCache) === npmCache, 'npm cache may not be a symlink');
    const cacheStat = await lstat(npmCache); safeMode(cacheStat, true);
    check(cacheStat.uid === process.getuid?.(), 'npm cache must be owned by the engine operator');
    temporary = await mkdtemp(join(base, 'heddle-reviewed-tests-'));
    const project = join(temporary, 'project'), runtime = join(temporary, 'runtime');
    await mkdir(project, { mode: 0o700 }); await mkdir(runtime, { mode: 0o700 });
    await writeFile(join(runtime, 'user.npmrc'), '', { mode: 0o600, flag: 'wx' });
    await writeFile(join(runtime, 'global.npmrc'), '', { mode: 0o600, flag: 'wx' });
    for (const entry of sorted(verified.entries)) {
      const target = join(project, entry.path);
      if (entry.type === 'directory') await mkdir(target, { mode: 0o700 });
      else await writeFile(target, verified.files.get(entry.path), { mode: entry.mode === '100755' ? 0o700 : 0o600, flag: 'wx' });
    }
    return { authorized: true, fixture: verified.fixture, sha256: verified.sha256, cwd: project, runtime, npmCache, cleanup: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    return { authorized: false, reason: reason(error) };
  }
}
