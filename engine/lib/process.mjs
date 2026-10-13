// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';

export class Rejection extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Commands receive argv directly; no project-controlled text enters a shell.
export function run(file, args, { cwd, env = {}, input, timeout = 120000, allowFailure = false, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8', ...env }, detached: true });
    const out = [], err = [];
    let bytes = 0, timedOut = false, overflow = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]]) {
      stream.on('data', data => { bytes += data.length; if (bytes > maxBytes) { overflow = true; kill(); } else chunks.push(data); });
    }
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const result = { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut, overflow };
      if (!allowFailure && (code !== 0 || timedOut || overflow)) {
        // Never echo argv/env/stderr: Git errors can repeat authentication headers. Only a fixed reason code leaves.
        const name = file.split('/').pop();
        const error = new Error(`${name} failed (exit ${code}${timedOut ? ', timeout' : ''}${overflow ? ', output limit' : ''})`);
        error.reason = failureReason(name, args, result);
        error.safeMessage = `${error.message}: ${error.reason}`;
        reject(error);
      } else resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Fixed vocabulary for why a child process failed; the subcommand comes only from engine-chosen argv.
const GIT_FAILURES = [
  ['auth', /could not read (Username|Password)|Authentication failed|returned error: 40[13]\b/],
  ['not_found', /Repository not found|repository '[^']*' not found|returned error: 404\b/i],
  ['not_our_ref', /not our ref|unadvertised object/],
  ['rejected', /\[(remote )?rejected\]|non-fast-forward|hook declined|failed to push some refs/],
  ['server_error', /returned error: 5\d\d\b|RPC failed|early EOF|unexpected disconnect/],
  ['network', /Could not resolve host|Failed to connect|Connection (refused|reset|timed out)|Operation timed out|SSL|TLS/],
  ['missing_object', /couldn't find remote ref|bad object|missing object|unknown revision|not a valid object/],
  ['ownership', /dubious ownership/],
];
export function failureReason(name, args, { timedOut, overflow, stderr }) {
  const tool = /^[a-z][a-z0-9-]{0,15}$/.test(name) ? name.replace(/-/g, '_') : 'process';
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (['-c', '-C', '--git-dir', '--work-tree'].includes(args[i])) { i++; continue; }
    if (String(args[i]).startsWith('-')) continue;
    words.push(String(args[i])); if (tool !== 'heddle' || words.length === 2) break;
  }
  const sub = words.filter(w => /^[a-z][a-z-]{0,19}$/.test(w)).join('_').replace(/-/g, '_');
  const what = sub ? `${tool}_${sub}` : tool;
  if (timedOut) return `${what}_timeout`;
  if (overflow) return `${what}_output_limit`;
  const text = String(stderr ?? '');
  const match = tool === 'git' ? GIT_FAILURES.find(([, pattern]) => pattern.test(text)) : undefined;
  return `${what}_${match ? match[0] : 'failed'}`;
}

export async function git(cwd, args, options = {}) {
  const result = await run('git', ['-c', 'protocol.version=1', ...args], { cwd, ...options });
  return result.stdout.toString().trim();
}

export function gitAuth(remote, write = false) {
  const token = write ? process.env.ARTIFACTS_WRITE_TOKEN : JSON.parse(process.env.ARTIFACTS_READ_TOKENS || '{}')[remote];
  // Git's environment config is equivalent to -c, without exposing tokens in ps.
  return token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` } : {};
}

export function remote(value) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || /[\r\n\0]/.test(value)) throw new Rejection('invalid_remote', 'Invalid Git remote');
  if (value.includes('://')) {
    let url; try { url = new URL(value); } catch { throw new Rejection('invalid_remote', 'Invalid Git remote'); }
    if (!['https:', 'http:', 'file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Rejection('invalid_remote', 'Use credential-free HTTP(S) or file remotes');
  } else if (!value.startsWith('/')) throw new Rejection('invalid_remote', 'Local remotes must be absolute paths');
  return value;
}

export function slug(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)) throw new Rejection('invalid_id', 'Invalid project, task or agent id');
  return value;
}
