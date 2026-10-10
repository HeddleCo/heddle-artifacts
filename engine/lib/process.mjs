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
        // Never echo argv/env/stderr: Git errors can repeat authentication headers.
        const error = new Error(`${file.split('/').pop()} failed (exit ${code}${timedOut ? ', timeout' : ''}${overflow ? ', output limit' : ''})`);
        error.safeMessage = error.message;
        reject(error);
      } else resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
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
    const url = new URL(value);
    if (!['https:', 'http:', 'file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Rejection('invalid_remote', 'Use credential-free HTTP(S) or file remotes');
  } else if (!value.startsWith('/')) throw new Rejection('invalid_remote', 'Local remotes must be absolute paths');
  return value;
}

export function slug(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)) throw new Rejection('invalid_id', 'Invalid project, task or agent id');
  return value;
}
