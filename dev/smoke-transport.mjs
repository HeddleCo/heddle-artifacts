// SPDX-License-Identifier: Apache-2.0
// Explicit per-run Git transport only. Never inherit proxy or trust settings.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { assertPrivateDirectory } from './smoke-auth.mjs';

export const PLATFORM_CA = Object.freeze({ path: '/usr/local/share/ca-certificates/nebula-dns.crt',
  sha256: 'ab6933a81e6f0d142e6d5f58ed465589d899a523c2752055761af11d4ee38f2b', uid: 65534 });
const validated = new WeakSet();
const invalid = () => { throw new Error('git_transport_config_invalid'); };
const artifactsRemote = /^https:\/\/[a-f0-9]{32}\.artifacts\.cloudflare\.net\/git\/[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,63}\.git$/i;
const validArtifactsRemote = value => typeof value === 'string' && artifactsRemote.exec(value)?.[0] === value;
export function validatePlatformProxy(proxy) {
  if (typeof proxy !== 'string') invalid();
  const match = proxy.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/);
  if (!match || match[0] !== proxy || Number(match[1]) > 65535) invalid();
  return `http://127.0.0.1:${match[1]}/`;
}
export function validateGitTransportConfig(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'caFile,caSha256,proxy,version'
    || value.version !== 1 || value.caFile !== PLATFORM_CA.path || value.caSha256 !== PLATFORM_CA.sha256
    || typeof value.proxy !== 'string') invalid();
  validatePlatformProxy(value.proxy);
  return value;
}
async function readBoundedFile(path, maxBytes, checkMetadata) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || await realpath(path) !== path) invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || !info.isFile() || info.nlink !== 1
      || info.size <= 0 || info.size > maxBytes || !checkMetadata(info)) invalid();
    const buffer = Buffer.alloc(maxBytes + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size || bytesRead > maxBytes) invalid();
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
export async function loadGitTransportConfig(path, { remote, home, platformProxy, readFileImpl = readBoundedFile } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || !validArtifactsRemote(remote)) invalid();
  await assertPrivateDirectory(dirname(path));
  const bytes = await readFileImpl(path, 4096, info => (!process.getuid || info.uid === process.getuid()) && (info.mode & 0o777) === 0o600);
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { invalid(); }
  validateGitTransportConfig(value);
  // Ports are per execution. Only an explicitly enabled launch supplies this one
  // environment value, and a stale config must not route Git through another listener.
  const proxy = validatePlatformProxy(value.proxy);
  if (proxy !== validatePlatformProxy(platformProxy)) invalid();
  const certificate = await readFileImpl(PLATFORM_CA.path, 131072, info => info.uid === PLATFORM_CA.uid && [0o644, 0o444].includes(info.mode & 0o777));
  if (createHash('sha256').update(certificate).digest('hex') !== PLATFORM_CA.sha256) throw new Error('git_transport_ca_mismatch');
  // Use the verified public CA bytes, not a source path that could change after hashing.
  await assertPrivateDirectory(home);
  const caFile = join(home, `git-transport-ca-${randomUUID()}.pem`), handle = await open(caFile, 'wx', 0o600);
  try { await handle.writeFile(certificate); await handle.sync(); } finally { await handle.close(); }
  const transport = Object.freeze({ proxy, caFile, caSha256: PLATFORM_CA.sha256, sourceCaFile: PLATFORM_CA.path, remote, home });
  validated.add(transport); return transport;
}
export function scopedGitTransport(transport, remote, home) {
  if (!validated.has(transport) || remote !== transport.remote || home !== transport.home || !validArtifactsRemote(remote)) invalid();
  return [[`http.${remote}.proxy`, transport.proxy], [`http.${remote}.sslCAInfo`, transport.caFile], [`http.${remote}.sslVerify`, 'true']];
}
const phases = new Set(['local_setup', 'main_push', 'candidate_push', 'notes_push', 'atomic_push', 'atomic_refs', 'rebuilt_notes_push', 'final_refs', 'seed_main', 'stage_proofs', 'staged_refs', 'main_cas', 'stale_main_cas', 'mirror_clone']);
export const safeGitPhase = phase => phases.has(phase) ? phase : 'unknown';
export function categorizeGitFailure(stderr) {
  if (/could not resolve proxy/i.test(stderr)) return 'git_proxy_dns';
  if (/could not resolve host/i.test(stderr)) return 'git_dns';
  if (/proxy authentication required|CONNECT tunnel failed.*407|received HTTP code 407/i.test(stderr)) return 'git_proxy_auth';
  if (/SSL certificate problem|server certificate verification failed|certificate verify failed|SSL peer certificate|error setting certificate verify locations/i.test(stderr)) return 'git_tls';
  if (/authentication failed|could not read Username|could not read Password|requested URL returned error:\s*(401|403)\b/i.test(stderr)) return 'git_auth';
  if (/repository[^\n]*not found|requested URL returned error:\s*404\b/i.test(stderr)) return 'git_remote_missing';
  if (/does not support.*--atomic|does not support atomic/i.test(stderr)) return 'git_atomic_unsupported';
  if (/\(stale info\)/i.test(stderr)) return 'git_stale_info';
  if (/non-fast-forward|\(fetch first\)/i.test(stderr)) return 'git_non_fast_forward';
  if (/failed to connect|couldn't connect|connection refused|connection reset/i.test(stderr)) return 'git_connect';
  if (/connection timed out|operation timed out|operation too slow/i.test(stderr)) return 'git_timeout';
  return 'git_failed';
}
export const GIT_FAILURE_CATEGORIES = Object.freeze(['git_proxy_dns', 'git_dns', 'git_proxy_auth', 'git_tls', 'git_auth', 'git_remote_missing', 'git_atomic_unsupported', 'git_non_fast_forward', 'git_stale_info', 'git_connect', 'git_timeout', 'git_failed']);
