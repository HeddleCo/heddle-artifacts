// SPDX-License-Identifier: Apache-2.0
// `up`: stand the app up with one command, then drive your own work from the UI and plain git.
//   node cli/up.mjs local    the real stack on this machine: real engine, real test runner, no cloud account
import { spawn, execFile } from 'node:child_process';
import { access, mkdir, writeFile, readFile, chmod, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isMain } from './ha.mjs';

const execFileAsync = promisify(execFile);
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HEDDLE_VERSION = '0.31.1', HEDDLE_REV = '0b5eec40276510d2723a1572bdea0e9640e66e33';
export const HEDDLE_INSTALL = `cargo install --locked --git https://github.com/HeddleCo/heddle --rev ${HEDDLE_REV} heddle-cli`;

/** Everything `up local` needs, checked before anything starts. Returns one problem per missing item, with how to fix it. */
export async function checkPrerequisites({ run = defaultRun, exists = defaultExists, nodeVersion = process.versions.node, env = process.env } = {}) {
  const problems = [];
  if (Number(nodeVersion.split('.')[0]) < 22) problems.push({ item: 'Node 22 or newer', fix: `You have Node ${nodeVersion}. Install Node 22+ (https://nodejs.org).` });
  for (const [name, args] of [['git', ['--version']], ['tar', ['--version']], ['zstd', ['--version']]]) {
    if (!(await run(name, args)).ok) problems.push({ item: name, fix: `Install ${name} and make sure it is on your PATH.` });
  }
  const heddle = env.HEDDLE_BIN || 'heddle', version = await run(heddle, ['--version']);
  if (!version.ok || !version.output.includes(HEDDLE_VERSION)) {
    problems.push({ item: `Heddle ${HEDDLE_VERSION}`, fix: `${version.ok ? `Found "${version.output.trim()}", which is not ${HEDDLE_VERSION}. ` : 'Not found. '}Install it (needs Rust; takes several minutes, so this command will not do it for you):\n    ${HEDDLE_INSTALL}\nOr set HEDDLE_BIN to a ${HEDDLE_VERSION} binary.` });
  }
  if (!(await exists(join(root, 'node_modules/wrangler/bin/wrangler.js')))) problems.push({ item: 'dependencies', fix: 'Run: npm ci' });
  if (!(await exists(join(root, 'ui/node_modules')))) problems.push({ item: 'UI dependencies', fix: 'Run: npm ci --prefix ui' });
  return problems;
}
async function defaultRun(file, args) { try { const { stdout, stderr } = await execFileAsync(file, args, { timeout: 15000 }); return { ok: true, output: `${stdout}${stderr}` }; } catch { return { ok: false, output: '' }; } }
async function defaultExists(path) { try { await access(path); return true; } catch { return false; } }

export async function freePort() {
  const listener = createServer();
  await new Promise(resolvePort => listener.listen(0, '127.0.0.1', resolvePort));
  const { port } = listener.address(); await new Promise(resolveClose => listener.close(resolveClose));
  return port;
}

/** The Wrangler config for the local stack, written (mode 0600) into the state directory so no secret is ever on a command line. */
const SECRET_VARS = ['OPERATOR_TOKEN', 'LOCAL_RUNNER_SECRET'];
export function localWranglerConfig({ repo = root, vars }) {
  // Wrangler prints a config's vars (secrets included) to the terminal and to its log. Secrets belong in localDevVars().
  for (const key of SECRET_VARS) if (key in vars) throw new Error(`${key} is a secret: pass it through localDevVars(), not the Worker config`);
  return {
    name: 'heddle-artifacts-local', main: join(repo, 'dev/local-worker.ts'), compatibility_date: '2026-08-15', compatibility_flags: ['nodejs_compat'],
    alias: { 'heddle-reviewer': join(repo, 'dev/no-reviewer.ts') },
    durable_objects: { bindings: [{ name: 'PROJECT', class_name: 'ProjectDO' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['ProjectDO'] }],
    r2_buckets: [{ binding: 'STATE', bucket_name: 'heddle-artifacts-state' }],
    assets: { directory: join(repo, 'ui/dist'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
    vars: { DEV: '1', DEMO_PROJECT: '', ...vars },
  };
}

/** The two secrets, for a mode-0600 .dev.vars file next to the config: wrangler loads it and prints the values as "(hidden)". */
export function localDevVars({ token, runnerSecret }) {
  for (const [name, value] of [['token', token], ['runner secret', runnerSecret]]) if (!/^[A-Za-z0-9._-]{16,128}$/.test(value ?? '')) throw new Error(`Refusing to write the ${name} to a dev-vars file: unexpected characters or length`);
  return `OPERATOR_TOKEN="${token}"\nLOCAL_RUNNER_SECRET="${runnerSecret}"\n`;
}

/** Whether ui/dist is missing or older than the sources it is built from (a stale build would show an old UI). */
export async function uiNeedsBuild(repo = root) {
  let built; try { built = (await stat(join(repo, 'ui/dist/app.js'))).mtimeMs; await stat(join(repo, 'ui/dist/index.html')); } catch { return true; }
  const newest = async path => {
    let latest = 0;
    let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { try { return (await stat(path)).mtimeMs; } catch { return 0; } }
    for (const entry of entries) latest = Math.max(latest, await newest(join(path, entry.name)));
    return latest;
  };
  for (const source of ['ui/src', 'ui/style.css', 'ui/index.html', 'ui/build.mjs']) if (await newest(join(repo, source)) > built) return true;
  return false;
}

/** The operator token: an existing good one is kept; a missing, empty, short or odd one is replaced. Always mode 0600. */
export async function readOrCreateToken(file) {
  let token = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (!/^[A-Za-z0-9._-]{32,256}$/.test(token)) { token = randomBytes(32).toString('hex'); await writeFile(file, `${token}\n`, { mode: 0o600 }); }
  await chmod(file, 0o600);
  return token;
}

export function parseArgs(argv) {
  const [target, ...rest] = argv, options = { target, state: join(homedir(), '.heddle-artifacts', 'local'), port: undefined };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--state') options.state = resolve(rest[++i] ?? ''); else if (rest[i] === '--port') options.port = Number(rest[++i]);
    else throw new Error(`Unknown option ${rest[i]}`);
  }
  if (options.port !== undefined && !(Number.isInteger(options.port) && options.port > 0 && options.port < 65536)) throw new Error('--port must be a port number');
  return options;
}

/** Poll until fn() is true. `abort()` returns a reason to give up at once (the process behind it died, or the user pressed Ctrl-C). */
export async function waitUntil(fn, ms, label, abort = () => null) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const reason = abort(); if (reason) throw new Error(`${label}: ${reason}`);
    try { if (await fn()) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} did not start in ${ms / 1000}s`);
}

export async function upLocal(options, log = console.log) {
  const problems = await checkPrerequisites();
  if (problems.length) {
    log('Cannot start yet. Missing:\n'); for (const p of problems) log(`  - ${p.item}\n    ${p.fix}\n`);
    return { code: 1 };
  }
  const { startFakeArtifacts } = await import('../dev/fake-artifacts/server.mjs');
  const { startEngineDevserver } = await import('../dev/engine-devserver.mjs');
  const { startLocalTestRunner, killLiveCandidates } = await import('../dev/local-test-runner.mjs');
  await mkdir(options.state, { recursive: true, mode: 0o700 });

  // Signal handlers go in before anything is started, so Ctrl-C at any point (even during startup) stops everything we started.
  let stopRequested = false, signals = 0, wake = () => {}, wrangler, buildChild;
  const started = [];
  const stop = async () => { for (const closeIt of started.splice(0).reverse()) { try { await closeIt(); } catch { /* best effort */ } } };
  const hardKill = () => { killLiveCandidates(); try { if (wrangler?.pid) process.kill(-wrangler.pid, 'SIGKILL'); } catch { /* gone */ } };
  const onSignal = () => { signals++; stopRequested = true; buildChild?.kill(); wake(); if (signals > 1) { hardKill(); process.exit(130); } };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const detach = () => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); };

  try {
    const tokenFile = join(options.state, 'operator-token'), token = await readOrCreateToken(tokenFile);
    const runnerSecret = randomBytes(24).toString('hex'), port = options.port ?? await freePort(), origin = `http://127.0.0.1:${port}`;
    if (await uiNeedsBuild()) {
      log('Building the UI (it is missing or older than its sources)…');
      await new Promise((res, rej) => { buildChild = spawn('npm', ['run', 'build', '--prefix', 'ui'], { cwd: root, stdio: 'ignore' }); buildChild.on('close', c => c === 0 ? res() : rej(new Error(stopRequested ? 'stopped' : 'UI build failed; run: npm run build'))); });
    }
    if (stopRequested) throw new Error('stopped');
    const fake = await startFakeArtifacts({ root: join(options.state, 'artifacts'), port: 0, eventUrl: `${origin}/__dev/events` }); started.push(() => fake.close());
    const engine = await startEngineDevserver({ root: join(options.state, 'engine'), port: 0, stub: false, engine: join(root, 'engine/engine.mjs') }); started.push(() => engine.close());
    // No root given: the runner makes its own private directory outside the state directory, so candidate code does not run next to your token.
    const runner = await startLocalTestRunner({ secret: runnerSecret }); started.push(() => runner.close());
    const config = join(options.state, 'wrangler.local.json');
    await writeFile(config, JSON.stringify(localWranglerConfig({ vars: { FAKE_ARTIFACTS_URL: fake.origin, ENGINE_DEV_URL: engine.origin, LOCAL_TEST_RUNNER_URL: runner.origin } }), null, 1), { mode: 0o600 });
    await writeFile(join(options.state, '.dev.vars'), localDevVars({ token, runnerSecret }), { mode: 0o600 });
    let wranglerExited = false;
    wrangler = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', config, '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', join(options.state, 'wrangler')],
      { cwd: root, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(options.state, 'wrangler.log'), XDG_CONFIG_HOME: join(options.state, 'config') } });
    wrangler.on('exit', () => { wranglerExited = true; wake(); });
    started.push(async () => { try { process.kill(-wrangler.pid, 'SIGTERM'); } catch { /* gone */ } await new Promise(r => setTimeout(r, 1500)); try { process.kill(-wrangler.pid, 'SIGKILL'); } catch { /* gone */ } });
    await waitUntil(async () => (await fetch(`${origin}/login`)).ok, 90000, 'The app', () => stopRequested ? 'stopped' : wranglerExited ? `wrangler exited before it was ready (see ${join(options.state, 'wrangler.log')})` : null);
    log(`\nHeddle Artifacts is running locally.\n\n  Open        ${origin}\n  Sign in     with the operator token in ${tokenFile}\n              (print it with: cat "${tokenFile}")\n  State       ${options.state}\n`);
    log('Next: in the app, create a project (optionally from a public repo), add a task, then give your own agent the\n`ha join …` command it shows. Candidate tests run on THIS machine, in a throwaway checkout, NOT in a sandbox:\ncandidate code can read your files, including the operator token above. Use it for your own agents only.\nPress Ctrl-C to stop.\n');
    await new Promise(resolveStop => { wake = resolveStop; if (stopRequested || wranglerExited) resolveStop(); });
    await stop(); detach();
    if (wranglerExited && !stopRequested) { log('The app stopped unexpectedly. See wrangler.log in the state directory.'); return { code: 1 }; }
    return { code: 0 };
  } catch (error) {
    await stop(); detach();
    if (error.message === 'stopped' || /: stopped$/.test(error.message)) { log('\nStopped.'); return { code: 130 }; }
    log(`\nCould not start: ${error.message}`); return { code: 1 };
  }
}

if (isMain(import.meta.url)) {
  Promise.resolve().then(async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.target !== 'local') throw new Error('Usage: node cli/up.mjs local [--state DIR] [--port N]');
    process.chdir(root);
    process.exitCode = (await upLocal(options)).code;
  }).catch(error => { console.error(`up: ${error.message}`); process.exitCode = 1; });
}
