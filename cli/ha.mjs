// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile, readFile, chmod, readdir } from 'node:fs/promises';
import { resolve, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

// Node resolves import.meta.url to the real path, even when argv uses a symlink.
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch { return false; }
}

export function projectURL(input) {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash ||
      !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use an HTTPS project URL, or HTTP on localhost, without credentials');
  }
  const match = url.pathname.match(/^\/(?:p|api\/projects)\/([a-zA-Z0-9_-]+)\/?$/);
  if (!match) throw new Error('Expected a project URL ending in /p/<project>');
  return { project: match[1], api: `${url.origin}/api/projects/${match[1]}` };
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid task or agent id');
  return value;
}
export function remoteURL(value, api) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(api).hostname);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (local && ['http:', 'file:'].includes(url.protocol)))) {
    throw new Error('Git remote must be HTTPS without embedded credentials (local fakes may use HTTP/file)');
  }
  return value;
}
// A project's first engine call boots its Container; live cold starts measured 10-57 s.
export const API_TIMEOUT_MS = 150000;
async function respond(url, token, body, method) {
  if (token && /[\r\n]/.test(token)) throw new Error('Invalid credential');
  let response;
  try {
    response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Error('API request failed or timed out'); }
  if (!response.ok) {
    // Do not echo server error text: setup scripts and credentials can occur there.
    const error = new Error(response.status === 409 ? 'HTTP 409: candidates changed, review again' : `HTTP ${response.status}: API request rejected`);
    error.status = response.status; throw error;
  }
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('API response exceeds 2 MiB');
  return text;
}
export async function request(url, token, body, method = body === undefined ? 'GET' : 'POST') {
  const text = await respond(url, token, body, method);
  try { return JSON.parse(text); } catch { throw new Error('API returned invalid JSON'); }
}
/** A plain-text API response, such as a candidate's `text/x-diff`. */
export async function requestText(url, token) { return respond(url, token, undefined, 'GET'); }
export function command(program, args, { cwd, env = {}, input, timeout = 60000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, settled = false;
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(stdout.trim()); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`${program} timed out`)); }, timeout);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) {
      child.kill('SIGKILL'); finish(new Error(`${program} output too large`));
    } else stdout += chunk; });
    child.stderr.on('data', () => {}); // Git and setup stderr can contain credentials. Never forward it.
    child.on('error', () => finish(new Error(`Unable to launch ${program}`)));
    child.on('close', code => finish(code === 0 ? undefined : new Error(`${program} failed (exit ${code})`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export function gitAuth(remotes) {
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(remotes.length), GIT_TRACE: '0', GIT_CURL_VERBOSE: undefined, GIT_TRACE_CURL: '0' };
  remotes.forEach(([url, token], i) => {
    if (typeof token !== 'string' || /[\r\n]/.test(token)) throw new Error('Invalid Git credential');
    env[`GIT_CONFIG_KEY_${i}`] = `http.${url}.extraHeader`;
    env[`GIT_CONFIG_VALUE_${i}`] = `Authorization: Bearer ${token}`;
  });
  return env;
}
const configQuote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
async function gitDirectory(cwd) {
  return resolve(cwd, await command('git', ['rev-parse', '--git-dir'], { cwd }));
}
export async function enrollment(input, options = {}) {
  const { api, project } = projectURL(input);
  const task = identifier(options.task), agent = identifier(options.as);
  const token = options.token ?? process.env.OPERATOR_TOKEN;
  if (!token) throw new Error('Set OPERATOR_TOKEN to enroll an agent');
  const result = await request(`${api}/tasks/${task}/agents`, token, {
    id: agent, kind: 'agent', displayName: agent,
    ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {}),
    ...(options.briefing === false ? { briefing: false } : {}),
  });
  if (typeof result.agentKey !== 'string' || typeof result.setup !== 'string' ||
      !result.fork || !result.upstream) throw new Error('Invalid §7.2 enrollment response');
  remoteURL(result.fork.remote, api); remoteURL(result.upstream.remote, api);
  gitAuth([[result.fork.remote, result.fork.token], [result.upstream.remote, result.upstream.readToken]]);
  return { ...result, api, project, task, agent };
}
/** Execute the trusted enrollment script in an empty directory; accept a single clone subdirectory. */
export async function joinProject(input, options = {}) {
  const target = resolve(options.directory ?? identifier(options.as));
  await mkdir(target, { recursive: true, mode: 0o700 });
  if ((await readdir(target)).length) throw new Error('Join needs an empty destination directory');
  const joined = await enrollment(input, options);
  const env = { ...gitAuth([[joined.fork.remote, joined.fork.token], [joined.upstream.remote, joined.upstream.readToken]]),
    OPERATOR_TOKEN: '', HA_AGENT_KEY: joined.agentKey };
  await command('sh', ['-eu'], { cwd: target, env: { OPERATOR_TOKEN: '', HA_AGENT_KEY: joined.agentKey,
    GIT_CONFIG_COUNT: '0', GIT_TRACE: '0', GIT_CURL_VERBOSE: undefined, GIT_TRACE_CURL: '0' },
    input: joined.setup, timeout: 90000 });
  let cwd = target;
  try {
    if (await command('git', ['rev-parse', '--show-toplevel'], { cwd }) !== cwd) throw new Error('parent checkout');
  } catch {
    const repos = [];
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const candidate = pathJoin(target, entry.name);
        try { await command('git', ['rev-parse', '--show-toplevel'], { cwd: candidate });
          // Parent worktree must never be mistaken for a clone.
          if (await command('git', ['rev-parse', '--show-toplevel'], { cwd: candidate }) === candidate) repos.push(candidate);
        } catch { /* not a clone */ }
      }
    }
    if (repos.length > 1) throw new Error('Setup created multiple clones; expected one');
    if (repos.length === 1) cwd = repos[0];
    else await command('git', ['clone', '--quiet', joined.fork.remote, '.'], { cwd, env });
  }
  const root = await command('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (root !== cwd) throw new Error('Setup did not create its own Git clone');
  for (const [name, url] of [['origin', joined.fork.remote], ['upstream', joined.upstream.remote]]) {
    try { await command('git', ['remote', 'get-url', name], { cwd });
      await command('git', ['remote', 'set-url', name, url], { cwd });
    } catch { await command('git', ['remote', 'add', name, url], { cwd }); }
  }
  for (const url of [joined.fork.remote, joined.upstream.remote]) {
    let configured = false;
    try { await command('git', ['config', '--local', '--get-all', `http.${url}.extraHeader`], { cwd }); configured = true; } catch { /* no local header */ }
    if (configured) await command('git', ['config', '--local', '--unset-all', `http.${url}.extraHeader`], { cwd });
  }
  const gitdir = await gitDirectory(cwd);
  const authPath = pathJoin(gitdir, 'ha-auth');
  await writeFile(authPath, [[joined.fork.remote, joined.fork.token], [joined.upstream.remote, joined.upstream.readToken]]
    .map(([url, value]) => `[http ${configQuote(url)}]\n\textraHeader = ${configQuote(`Authorization: Bearer ${value}`)}\n`).join(''), { mode: 0o600 });
  await chmod(authPath, 0o600);
  await command('git', ['config', '--local', '--add', 'include.path', authPath], { cwd });
  await command('git', ['config', '--local', 'protocol.version', '1'], { cwd });
  await command('git', ['config', '--local', 'user.name', joined.agent], { cwd });
  await command('git', ['config', '--local', 'user.email', `${joined.agent}@demo.heddle.local`], { cwd });
  await command('git', ['config', '--local', 'notes.displayRef', 'refs/notes/heddle*'], { cwd });
  const state = { api: joined.api, project: joined.project, task: joined.task, agent: joined.agent, agentKey: joined.agentKey };
  await writeFile(pathJoin(gitdir, 'ha.json'), JSON.stringify(state) + '\n', { mode: 0o600 });
  // Setup scripts may write headers in .git/config; protect that too.
  await chmod(pathJoin(gitdir, 'config'), 0o600);
  return { cwd, ...state };
}
export async function localState(cwd = process.cwd()) {
  return JSON.parse(await readFile(pathJoin(await gitDirectory(cwd), 'ha.json'), 'utf8'));
}
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/token|agentKey|setup/i.test(key)).map(([key, val]) => [key, redact(val)]));
  return typeof value === 'string' ? value.replace(/art_v1_[^\s"'<>]+/g, '[REDACTED]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]') : value;
}
export async function main(args = process.argv.slice(2)) {
  const [action, value, ...rest] = args;
  if (action === 'join') {
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i];
      if (!['--task', '--as', '--dir', '--provider', '--model'].includes(key) || !rest[i + 1]) throw new Error('Invalid join options');
      options[key === '--dir' ? 'directory' : key.slice(2)] = rest[i + 1];
    }
    const result = await joinProject(value, options);
    console.log(`Joined ${result.project}/${result.task} as ${result.agent}. Clone: ${result.cwd}`);
  } else if (action === 'status' || action === 'why') {
    const state = await localState();
    if (action === 'why' && !/^[a-f0-9]{40,64}$/.test(value ?? '')) throw new Error('why requires a full Git SHA');
    const result = await request(action === 'status' ? state.api : `${state.api}/why/${value}`, state.agentKey);
    console.log(action === 'status' ? JSON.stringify(redact(result), null, 2) : redact(result.narrative));
  } else throw new Error('Usage: node cli/ha.mjs join <url> --task t --as a [--dir dir] | status | why <sha>');
}
if (isMain(import.meta.url)) {
  main().catch(error => { console.error(`ha: ${error.message}`); process.exitCode = 1; });
}
