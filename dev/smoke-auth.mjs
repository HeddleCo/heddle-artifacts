// SPDX-License-Identifier: Apache-2.0
// No login, credential discovery, or ambient-home fallback. Only call after approval.
import { spawn } from 'node:child_process';
import { lstat, realpath, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTH_LIMITS = Object.freeze({ timeoutMs: 10000, maxOutputBytes: 16384 });
const wranglerPackage = fileURLToPath(new URL('../node_modules/wrangler/', import.meta.url));
const below = (parent, child) => { const part = relative(parent, child); return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
export async function assertPrivateDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw new Error('private_directory_required');
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
    || (process.getuid && info.uid !== process.getuid()) || await realpath(path) !== path) throw new Error('private_directory_required');
  return path;
}
export async function validateOAuthHome(home, xdgConfigHome = home && join(home, 'config')) {
  // A selected, private temporary home is mandatory; never inspect the operator's auth store.
  // Use the approved /tmp location explicitly; inherited TMPDIR must not redirect auth selection.
  if (typeof home !== 'string' || !below(await realpath('/tmp'), home)
    || resolve(home) === resolve(homedir())) throw new Error('private_oauth_home_required');
  await assertPrivateDirectory(home);
  if (!below(home, xdgConfigHome)) throw new Error('private_oauth_home_required');
  await assertPrivateDirectory(xdgConfigHome);
  // Wrangler also recognizes HOME/.wrangler and nested config files. Inspect only
  // metadata in this selected temporary tree, never credential contents. Reject
  // every symlink/hardlink so neither legacy paths nor nested config can escape.
  let entries = 0;
  const inspect = async (directory, depth) => {
    if (depth > 8) throw new Error('private_oauth_home_required');
    for (const name of await readdir(directory)) {
      if (++entries > 256) throw new Error('private_oauth_home_required');
      const path = join(directory, name), info = await lstat(path);
      if (info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new Error('private_oauth_home_required');
      if (info.isDirectory()) { if ((info.mode & 0o777) !== 0o700) throw new Error('private_oauth_home_required'); await inspect(path, depth + 1); }
      else if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error('private_oauth_home_required');
    }
  };
  await inspect(home, 0);
  return { home, xdgConfigHome };
}
export function safeOAuthEnv(home, xdgConfigHome = join(home, 'config')) {
  return { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: xdgConfigHome,
    XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
    TMPDIR: home, LANG: 'C', LC_ALL: 'C', CI: 'true', NO_COLOR: '1',
    CLOUDFLARE_AUTH_USE_KEYRING: 'false', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' };
}
export function parseOAuthToken(text) {
  let value; try { value = JSON.parse(text); } catch { throw new Error('oauth_output_invalid'); }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'token,type'
    || value.type !== 'oauth' || typeof value.token !== 'string'
    || !/^[A-Za-z0-9._~+\/-]{1,8192}={0,2}$/.test(value.token)) throw new Error('oauth_output_invalid');
  return value.token;
}
export async function getPrivateOAuthToken({ home, xdgConfigHome, timeoutMs = AUTH_LIMITS.timeoutMs, spawnImpl = spawn } = {}) {
  const selected = await validateOAuthHome(home, xdgConfigHome);
  // The output contract and switches are verified for this installed version only.
  const pkg = JSON.parse(await readFile(join(wranglerPackage, 'package.json'), 'utf8'));
  if (pkg.name !== 'wrangler' || pkg.version !== '4.149.0') throw new Error('oauth_cli_version_mismatch');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > AUTH_LIMITS.timeoutMs) throw new Error('oauth_timeout');
  return new Promise((resolveToken, reject) => {
    let child;
    try {
      child = spawnImpl(process.execPath, [join(wranglerPackage, 'bin/wrangler.js'), 'auth', 'token', '--json'], {
        cwd: selected.home, env: safeOAuthEnv(selected.home, selected.xdgConfigHome),
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { reject(new Error('oauth_spawn_failed')); return; }
    let bytes = 0, failure, settled = false; const chunks = [];
    const clear = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const kill = reason => { failure ??= reason; try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    const timer = setTimeout(() => kill('oauth_timeout'), timeoutMs);
    const collect = (data, keep) => {
      bytes += data.length;
      if (bytes > AUTH_LIMITS.maxOutputBytes) kill('oauth_output_limit');
      else if (keep) chunks.push(Buffer.from(data));
    };
    child.stdout.on('data', data => collect(data, true));
    // Never retain, print, or attach subprocess diagnostics, even on failure.
    child.stderr.on('data', data => collect(data, false));
    child.on('error', () => { if (settled) return; settled = true; clearTimeout(timer); clear(); reject(new Error('oauth_spawn_failed')); });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      try {
        if (failure || code !== 0) throw new Error(failure ?? 'oauth_command_failed');
        const output = Buffer.concat(chunks);
        try { resolveToken(parseOAuthToken(output.toString('utf8'))); } finally { output.fill(0); }
      } catch (error) { reject(error); } finally { clear(); }
    });
  });
}
