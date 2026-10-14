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
function exec(args, { cwd, env, deadline, cap = TEST_OUTPUT_BYTES + 1 }) {
  return new Promise(resolve => {
    const child = spawn(args[0], args.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, overflow = false, timedOut = false;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, Math.max(1, deadline - Date.now()));
    const take = chunk => { if (size >= cap) { overflow = true; return; } chunks.push(chunk); size += chunk.length; };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', () => { clearTimeout(timer); resolve({ code: 127, output: '', timedOut, overflow }); });
    child.on('close', code => { clearTimeout(timer); killGroup(); resolve({ code: timedOut ? 124 : code ?? 1, output: Buffer.concat(chunks).toString('utf8'), timedOut, overflow }); });
  });
}

/**
 * input: { sourceSha, treeSha, remote, readCredential, recipe? } as for the Sandbox runner (worker/isolated-tests.ts).
 * Returns the same SandboxRun shape, so the coordinator and the UI treat it exactly like a sandbox result.
 */
export async function runCandidateLocally(input, { root = join(tmpdir(), 'heddle-local-tests'), allowFileRemotes = false } = {}) {
  const recipe = checkRecipe(input.recipe);
  if (!SHA.test(input.sourceSha) || !SHA.test(input.treeSha)) throw new Error('invalid sha');
  const { local } = checkRemote(input.remote, allowFileRemotes);
  const start = Date.now(), deadline = start + recipe.budgetMs;
  const result = { sourceSha: input.sourceSha, treeSha: input.treeSha, output: '', durationMs: 0, ...(input.recipe ? { budgetMs: recipe.budgetMs } : {}) };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'run-')), cwd = join(dir, 'candidate'), home = join(dir, 'home');
  try {
    await mkdir(cwd); await mkdir(home);
    // Git gets the credential through its own environment config; the candidate's steps never do.
    const gitEnv = { PATH: process.env.PATH, HOME: home, GIT_TERMINAL_PROMPT: '0',
      ...(local ? {} : { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${input.readCredential}` }) };
    const step = async (args, env = gitEnv) => exec(args, { cwd, env, deadline });
    if ((await step(['git', 'init', cwd])).code !== 0) throw new Error('init');
    const fetched = await step(['git', 'fetch', '--no-tags', '--depth=1', '--', input.remote, input.sourceSha]);
    if (fetched.timedOut) { result.failure = 'timeout'; return result; }
    if (fetched.code !== 0) throw new Error('fetch');
    if ((await step(['git', 'checkout', '--detach', input.sourceSha])).code !== 0) throw new Error('checkout');
    const sha = await step(['git', 'rev-parse', 'HEAD']), tree = await step(['git', 'rev-parse', 'HEAD^{tree}']);
    if (sha.output.trim() !== input.sourceSha || tree.output.trim() !== input.treeSha) { result.failure = 'checkout'; return result; }
    const env = { PATH: process.env.PATH, CI: '1', NO_COLOR: '1', HOME: home, TMPDIR: home, NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
    for (const args of recipe.setup) {
      const run = await exec(args, { cwd, env, deadline });
      result.installExitCode = run.code;
      if (run.timedOut) { result.failure = 'timeout'; return result; }
      if (run.code !== 0) return result;
    }
    const test = await exec(recipe.test, { cwd, env, deadline });
    result.testExitCode = test.code; result.output = test.output;
    if (test.timedOut) result.failure = 'timeout'; else if (test.overflow) result.failure = 'output';
    return result;
  } catch (error) {
    result.failure ||= /^(init|fetch|checkout)$/.test(error?.message) ? 'checkout' : 'sandbox';
    return result;
  } finally {
    result.durationMs = Date.now() - start;
    await rm(dir, { recursive: true, force: true });
  }
}

/** A loopback-only HTTP wrapper for the Worker: POST /run with the shared secret header. At most `slots` runs at once. */
export async function startLocalTestRunner({ port = 0, root, secret, slots = 2, allowFileRemotes = false } = {}) {
  if (!secret || secret.length < 24) throw new Error('A runner secret of at least 24 characters is required');
  const want = Buffer.from(secret); let active = 0;
  const server = createServer(async (req, res) => {
    const end = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };
    try {
      const got = Buffer.from(String(req.headers['x-runner-secret'] ?? ''));
      if (req.method !== 'POST' || req.url !== '/run' || got.length !== want.length || !timingSafeEqual(got, want)) return end(404, { error: 'not_found' });
      if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return end(415, { error: 'json_required' });
      if (active >= slots) return end(429, { error: 'busy' });
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 65536) return end(413, { error: 'too_large' }); }
      active++;
      try { end(200, await runCandidateLocally(JSON.parse(text), { root, allowFileRemotes })); } finally { active--; }
    } catch (error) { end(400, { error: /^invalid (recipe|remote|sha)/.test(error?.message) ? error.message : 'bad_request' }); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
