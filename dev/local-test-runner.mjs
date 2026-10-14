// SPDX-License-Identifier: Apache-2.0
// Runs a candidate's tests for real on THIS machine, for `up local`. It is not isolated: candidate code runs with
// your user's privileges, in a throwaway checkout, with a minimal environment. Use it for your own agents' work.
// The Cloudflare deployment tests in a keyless Sandbox instead (worker/test-sandbox.ts).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_OUTPUT_BYTES, TEST_BUDGET_MS } from '../engine/lib/isolated-tests.mjs';

const PROGRAMS = new Set(['npm', 'npx', 'node']);
const DEFAULT_RECIPE = { setup: [['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']], test: ['npm', 'test'], budgetMs: TEST_BUDGET_MS };
const SHA = /^[a-f0-9]{40}$/;
// Every candidate process group that is running right now, so shutting the runner down can stop them.
const liveGroups = new Set();
export function killLiveCandidates() { killLive(); }
function killLive() { for (const pid of liveGroups) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } } liveGroups.clear(); }

function argv(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 48 || !PROGRAMS.has(value[0]) ||
      value.some(a => typeof a !== 'string' || !a || a.length > 256 || /[\0-\x1f\x7f]/.test(a))) throw new Error('invalid recipe: only npm, npx and node, as argument lists');
  return value;
}
function checkRecipe(recipe = DEFAULT_RECIPE) {
  const setup = recipe.setup ?? [];
  if (!Array.isArray(setup) || setup.length > 6 || !Number.isInteger(recipe.budgetMs) || recipe.budgetMs < 1000 || recipe.budgetMs > 600000) throw new Error('invalid recipe');
  return { setup: setup.map(argv), test: argv(recipe.test), budgetMs: recipe.budgetMs };
}
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
function checkRemote(remote, allowFileRemotes) {
  if (allowFileRemotes && typeof remote === 'string' && remote.startsWith('/')) return { local: true };
  const url = new URL(remote);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname)))) throw new Error('invalid remote');
  return { local: false };
}

/** One bounded child process. Resolves with its exit code and combined output; kills the whole group on timeout. */
function exec(args, { cwd, env, deadline, cap = TEST_OUTPUT_BYTES + 1, groups }) {
  return new Promise(resolve => {
    const child = spawn(args[0], args.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) { liveGroups.add(child.pid); groups?.add(child.pid); }
    const chunks = []; let size = 0, overflow = false, timedOut = false;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, Math.max(1, deadline - Date.now()));
    const take = chunk => { if (size >= cap) { overflow = true; return; } chunks.push(chunk); size += chunk.length; };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', () => { clearTimeout(timer); liveGroups.delete(child.pid); groups?.delete(child.pid); resolve({ code: 127, output: '', timedOut, overflow }); });
    child.on('close', code => { clearTimeout(timer); killGroup(); liveGroups.delete(child.pid); groups?.delete(child.pid); resolve({ code: timedOut ? 124 : code ?? 1, output: Buffer.concat(chunks).toString('utf8'), timedOut, overflow }); });
  });
}

/**
 * input: { sourceSha, treeSha, remote, readCredential, recipe? } as for the Sandbox runner (worker/isolated-tests.ts).
 * Returns the same SandboxRun shape, so the coordinator and the UI treat it exactly like a sandbox result.
 */
export async function runCandidateLocally(input, { root, allowFileRemotes = false, signal, beforeSteps } = {}) {
  if (!root) throw new Error('A private work directory is required (no shared default: a predictable path in /tmp can be taken over)');
  const recipe = checkRecipe(input.recipe);
  if (!SHA.test(input.sourceSha) || !SHA.test(input.treeSha)) throw new Error('invalid sha');
  const { local } = checkRemote(input.remote, allowFileRemotes);
  const start = Date.now(); let deadline = start + recipe.budgetMs, waitedMs = 0;
  // `local` is this runner saying what it is, so the board labels the result from the runner and not from a setting.
  const result = { sourceSha: input.sourceSha, treeSha: input.treeSha, output: '', durationMs: 0, local: true, ...(input.recipe ? { budgetMs: recipe.budgetMs } : {}) };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'run-')), cwd = join(dir, 'candidate'), home = join(dir, 'home');
  // `signal` is the client giving up, or the runner shutting down: stop what is running and start nothing more.
  const groups = new Set(), onAbort = () => { for (const pid of groups) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } } };
  signal?.addEventListener('abort', onAbort, { once: true });
  const go = (args, e) => { if (signal?.aborted) throw new Error('aborted'); return exec(args, { cwd, env: e, deadline, groups }); };
  try {
    await mkdir(cwd); await mkdir(home);
    // Git gets the credential through its own environment config; the candidate's steps never do.
    const gitEnv = { PATH: process.env.PATH, HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
      ...(local ? {} : { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${input.readCredential}` }) };
    const step = async (args, env = gitEnv) => go(args, env);
    if ((await step(['git', 'init', cwd])).code !== 0) throw new Error('init');
    const fetched = await step(['git', 'fetch', '--no-tags', '--depth=1', '--', input.remote, input.sourceSha]);
    if (fetched.timedOut) { result.failure = 'timeout'; return result; }
    if (fetched.code !== 0) throw new Error('fetch');
    if ((await step(['git', 'checkout', '--detach', input.sourceSha])).code !== 0) throw new Error('checkout');
    const sha = await step(['git', 'rev-parse', 'HEAD']), tree = await step(['git', 'rev-parse', 'HEAD^{tree}']);
    if (sha.output.trim() !== input.sourceSha || tree.output.trim() !== input.treeSha) { result.failure = 'checkout'; return result; }
    // Authenticate before queueing; neither credential expiry nor queue wait consumes the test budget.
    if (beforeSteps) {
      const waiting = Date.now(); await beforeSteps(); waitedMs = Date.now() - waiting; deadline += waitedMs;
    }
    const env = { PATH: process.env.PATH, CI: '1', NO_COLOR: '1', HOME: home, TMPDIR: home, NPM_CONFIG_UPDATE_NOTIFIER: 'false', GIT_CONFIG_NOSYSTEM: '1' };
    result.installExitCode = 0;
    for (const args of recipe.setup) {
      const run = await go(args, env);
      result.installExitCode = run.code;
      if (run.timedOut) { result.failure = 'timeout'; return result; }
      if (run.code !== 0) return result;
    }
    const test = await go(recipe.test, env);
    result.testExitCode = test.code; result.output = test.output;
    if (test.timedOut) result.failure = 'timeout'; else if (test.overflow) result.failure = 'output';
    return result;
  } catch (error) {
    result.failure ||= /^(init|fetch|checkout)$/.test(error?.message) ? 'checkout' : 'sandbox';
    return result;
  } finally {
    signal?.removeEventListener('abort', onAbort); onAbort();
    result.durationMs = Date.now() - start - waitedMs;
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A loopback-only HTTP wrapper for the Worker: POST /run with the shared secret header.
 * Checkout happens on admission, while credentials are fresh. At most `slots` candidate recipes run at once; further requests wait in a queue of at most `maxQueue` (then 429 "busy"), so a burst of pushes is
 * tested in turn instead of some candidates being reported as errors for tests that never ran.
 * Without `root` the runner makes a private (0700) directory of its own and removes it on close.
 */
export async function startLocalTestRunner({ port = 0, root, secret, slots = 2, maxQueue = 64, allowFileRemotes = false } = {}) {
  if (!secret || secret.length < 24) throw new Error('A runner secret of at least 24 characters is required');
  const own = !root; root ??= await mkdtemp(join(tmpdir(), 'heddle-local-tests-'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const want = Buffer.from(secret), waiters = [], lifecycle = new AbortController(); let running = 0, admitted = 0, closing = false;
  // A waiter that gives up leaves the queue; it never takes a slot.
  const acquire = signal => {
    if (closing || signal.aborted) return Promise.resolve(false);
    if (running < slots) { running++; return Promise.resolve(true); }
    return new Promise(res => { const waiter = ok => { signal.removeEventListener('abort', leave); res(ok); }, leave = () => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); res(false); }; signal.addEventListener('abort', leave, { once: true }); waiters.push(waiter); });
  };
  const release = () => { const next = waiters.shift(); if (next) next(true); else running--; };
  const server = createServer(async (req, res) => {
    const end = (status, body) => { if (!res.writableEnded) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };
    try {
      const got = Buffer.from(String(req.headers['x-runner-secret'] ?? ''));
      if (req.method !== 'POST' || req.url !== '/run' || got.length !== want.length || !timingSafeEqual(got, want)) return end(404, { error: 'not_found' });
      if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return end(415, { error: 'json_required' });
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 65536) return end(413, { error: 'too_large' }); }
      const input = JSON.parse(text), gone = new AbortController(), signal = AbortSignal.any([gone.signal, lifecycle.signal]);
      res.on('close', () => { if (!res.writableEnded) gone.abort(); });
      if (closing) return end(503, { error: 'shutting_down' });
      if (admitted >= slots + maxQueue) return end(429, { error: 'busy' });
      admitted++;
      let acquired = false;
      try {
        const beforeSteps = async () => {
          acquired = await acquire(signal);
          if (!acquired) throw new Error('aborted');
        };
        end(200, await runCandidateLocally(input, { root, allowFileRemotes, signal, beforeSteps }));
      } finally { admitted--; if (acquired) release(); }
    } catch (error) { end(400, { error: /^invalid (recipe|remote|sha)/.test(error?.message) ? error.message : 'bad_request' }); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`, root,
    async close() {
      closing = true; lifecycle.abort(); for (const w of waiters.splice(0)) w(false);
      // lifecycle.abort() stops only this runner’s groups; the global kill is for whole-app shutdown.
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (own) await rm(root, { recursive: true, force: true });
    },
  };
}
