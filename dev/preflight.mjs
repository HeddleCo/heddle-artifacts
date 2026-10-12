// SPDX-License-Identifier: Apache-2.0
// Account-free, fixed-plan rehearsal checks. Never installs application/browser
// dependencies, deploys, authenticates, or invokes a live model.
import { spawn, spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, delimiter, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SOURCE_DIRS = ['.github', 'cli', 'contracts', 'demo', 'dev', 'docs', 'engine', 'reviewer', 'scripts', 'ui', 'worker'];
const OMIT = new Set(['node_modules', '.git', '.wrangler', '.local', 'dist', 'test-results', 'playwright-report', 'evidence']);
const ROOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'wrangler.jsonc', 'wrangler.dev.jsonc', '.dockerignore', '.gitignore', 'README.md', 'LICENSE', 'NOTICE'];
const LOCKS = ['package-lock.json', 'reviewer/package-lock.json', 'ui/package-lock.json', 'demo/seed-project/package-lock.json'];

export function parseArgs(args) {
  const options = { plan: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plan') options.plan = true;
    else if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('--') && !options.output) options.output = args[++i];
    else throw new Error('Usage: node dev/preflight.mjs [--plan] [--output NEW_DIRECTORY]');
  }
  return options;
}

export function buildPlan({ native = false } = {}) {
  const check = (id, cwd, args, requires, timeoutMs = 120000, dependsOn = []) => ({ id, cwd, args, requires, timeoutMs, dependsOn });
  return [
    check('root-typecheck', '.', ['node_modules/typescript/bin/tsc', '--noEmit'], ['node_modules/typescript/bin/tsc']),
    check('ui-typecheck', 'ui', ['node_modules/typescript/bin/tsc', '--noEmit'], ['node_modules/typescript/bin/tsc']),
    check('ui-build', 'ui', ['build.mjs'], ['node_modules/esbuild/package.json']),
    check('worker-tests', '.', ['node_modules/vitest/vitest.mjs', 'run'], ['node_modules/vitest/vitest.mjs', 'node_modules/wrangler/bin/wrangler.js'], 180000, ['ui-build']),
    check('dev-tests', '.', ['--test', '@dev-tests'], ['node_modules/typescript/package.json', 'node_modules/ajv/package.json']),
    check('reviewer-typecheck', 'reviewer', ['node_modules/typescript/bin/tsc', '--noEmit'], ['node_modules/typescript/bin/tsc']),
    check('reviewer-tests', 'reviewer', ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1'], ['node_modules/vitest/vitest.mjs']),
    check('ui-unit', 'ui', ['--test', '@ui-tests'], ['node_modules/esbuild/package.json', 'node_modules/preact/package.json']),
    check('ui-decision-negative', 'ui', ['test/decision-negative.mjs'], ['node_modules/preact/package.json']),
    check('ui-verification-negative', 'ui', ['test/verification-negative.mjs'], []),
    check('trusted-fixture-manifest', '.', ['scripts/generate-trusted-test-trees.mjs'], []),
    // CI=1 forbids reusing an unrelated server. The repository config owns the
    // loopback mock Worker; UI_TEST_URL is never forwarded.
    check('ui-browser', 'ui', ['node_modules/@playwright/test/cli.js', 'test', '--max-failures=1', '--workers=1', '--retries=0', '--output', '@browser-output'], ['node_modules/@playwright/test/cli.js', 'node_modules/wrangler/bin/wrangler.js'], 180000, ['ui-build']),
    ...(native ? [check('native-storyline', '.', ['dev/local-flow.mjs', '--storyline'], ['node_modules/wrangler/bin/wrangler.js'], 300000, ['ui-build', 'trusted-fixture-manifest'])] : []),
  ];
}

// Allowlist instead of deleting a few known token names. Browser/cache paths
// may be explicit, but no user home, proxy, auth, NODE_OPTIONS, alternate model,
// engine, fixture manifest, UI origin, or npm configuration is inherited.
export function safeEnvironment(ambient, runtime, { native = false, browserCache } = {}) {
  if (ambient.UI_TEST_URL) throw new Error('UI_TEST_URL is not accepted: preflight owns its loopback fixture server.');
  const env = {
    PATH: ambient.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: join(runtime, 'home'),
    XDG_CONFIG_HOME: join(runtime, 'config'), XDG_CACHE_HOME: join(runtime, 'cache'),
    TMPDIR: ambient.TMPDIR || tmpdir(), LANG: 'C.UTF-8', CI: '1', NO_COLOR: '1',
    WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(runtime, 'wrangler.log'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_USERCONFIG: join(runtime, 'npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(runtime, 'global.npmrc'),
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  };
  if (ambient.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = resolve(ambient.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  if (ambient.PLAYWRIGHT_BROWSERS_PATH || browserCache) env.PLAYWRIGHT_BROWSERS_PATH = ambient.PLAYWRIGHT_BROWSERS_PATH || browserCache;
  if (native) {
    if (!ambient.HEDDLE_BIN?.trim()) throw new Error('Native story requires an explicit HEDDLE_BIN.');
    env.HEDDLE_BIN = resolve(ambient.HEDDLE_BIN);
  }
  return env;
}

export async function assertNoRuntimeEnvFiles(root) {
  // Wrangler loads these independently of process.env. npm also honors a
  // project .npmrc even with isolated user/global configuration.
  for (const scope of ['.', 'ui', 'reviewer']) {
    for (const file of await readdir(resolve(root, scope))) {
      if (file === '.env' || file.startsWith('.env.') || file === '.dev.vars' || file.startsWith('.dev.vars.') || file === '.npmrc') {
        throw new Error(`Runtime configuration file is not allowed in preflight: ${scope}/${file}. Use a clean source copy; no file was read or changed.`);
      }
    }
  }
}

export async function sourceMetadata(root) {
  const files = [];
  async function add(path) {
    const info = await lstat(join(root, path));
    if (!info.isFile()) throw new Error(`Source must be a regular file: ${path}`);
    files.push({ path: path.split('\\').join('/'), bytes: info.size, mode: info.mode & 0o777, sha256: sha256(await readFile(join(root, path))) });
  }
  async function walk(path) {
    for (const item of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (OMIT.has(item.name) || item.name.startsWith('.env') || item.name === '.dev.vars' || item.name.endsWith('.log')) continue;
      const child = join(path, item.name);
      if (item.isDirectory()) await walk(child); else await add(child);
    }
  }
  for (const file of ROOT_FILES) await add(file);
  for (const dir of SOURCE_DIRS) await walk(dir);
  // These public reviewed replay fixture bytes are inputs to the trust gate.
  await walk('demo/evidence/genuine-native-v1/candidates');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: sha256(JSON.stringify(files)), files, locks: files.filter(file => LOCKS.includes(file.path)),
    excludes: [...OMIT, '.env*', '.dev.vars', '*.log'], node: process.version, platform: process.platform, arch: process.arch };
}

export function sanitizeLog(text, replacements = []) {
  let out = text.replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+/gi, '$1[redacted]')
    .replace(/\b((?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))[A-Z_]*\s*[:=]\s*)[^\s,}]+/g, '$1[redacted]')
    .replace(/(https?:\/\/)[^/\s@]+@/g, '$1[redacted]@');
  for (const [before, after] of replacements) if (before) out = out.split(before).join(after);
  return out;
}

// Include detached descendants used by local-flow/Wrangler. This is cleanup,
// not a security sandbox. Only descendants of this check are ever selected.
function descendants(pid) {
  if (process.platform === 'win32') return [];
  const listing = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000, env: { PATH: process.env.PATH } });
  if (listing.status !== 0) return [];
  const rows = listing.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const found = new Set([pid]);
  for (let previous = 0; previous !== found.size;) { previous = found.size; for (const [id, parent] of rows) if (found.has(parent)) found.add(id); }
  return [...found].filter(id => id !== pid).reverse();
}

export function runProcess(file, args, { cwd, env, timeoutMs = 120000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise(resolveResult => {
    const start = Date.now(), chunks = [];
    let timedOut = false, overflow = false, bytes = 0, spawnError;
    const child = spawn(file, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stopping;
    const stop = () => {
      if (stopping) return;
      const owned = child.pid ? [...descendants(child.pid), child.pid] : [];
      const kill = signal => { for (const pid of owned) { try { process.kill(-pid, signal); } catch {} try { process.kill(pid, signal); } catch {} } };
      kill('SIGTERM');
      stopping = new Promise(done => setTimeout(() => { kill('SIGKILL'); done(); }, 750));
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= maxBytes) chunks.push(chunk); else if (!overflow) { overflow = true; stop(); }
    });
    child.on('error', error => { spawnError = error.code || 'spawn_failed'; });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      // Detached descendants may close their inherited pipes before exiting.
      // Always finish the bounded hard-kill sweep before returning evidence.
      if (stopping) await stopping;
      resolveResult({ status: code === 0 && !timedOut && !overflow && !spawnError ? 'passed' : 'failed', code, signal, timedOut, overflow,
        ...(spawnError ? { error: spawnError } : {}), durationMs: Date.now() - start, output: Buffer.concat(chunks).toString() });
    });
  });
}

export function exitCode(results, sourceChanged = false) {
  return sourceChanged || results.some(result => result.status !== 'passed' && result.status !== 'not-requested') ? 1 : 0;
}

async function executable(name, path) {
  for (const dir of path.split(delimiter)) {
    try { const file = join(dir, name); await access(file, constants.X_OK); return await realpath(file); } catch {}
  }
  throw new Error(`Missing ${name}; preflight never installs dependencies.`);
}

export function npmGuardSource(npm, native) {
  // The native engine intentionally reconstructs approved fixture dependencies
  // in fresh copies. Permit only its existing ci command, forced offline. The
  // default preflight refuses every install. No package/browser auto-install.
  return `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nconst args = process.argv.slice(2);\nconst fixtureInstall = ${native} && args[0] === 'ci' && args.includes('--ignore-scripts');\nconst localRun = (args[0] === 'test' && args.slice(1).every(x => x === '--silent')) || (args[0] === 'run' && args[1] === 'dev:worker' && args.length === 2);\nif (!fixtureInstall && !localRun) { console.error('Preflight blocked an unexpected npm command; no automatic installs or remote actions.'); process.exit(2); }\nconst result = spawnSync(process.execPath, [${JSON.stringify(npm)}, ...args, ...(fixtureInstall ? ['--offline', '--ignore-scripts', '--no-audit', '--no-fund'] : [])], { stdio: 'inherit', env: { ...process.env, NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false' } });\nprocess.exit(result.status ?? 1);\n`;
}

export async function main(args = process.argv.slice(2), ambient = process.env) {
  const options = parseArgs(args), native = !!ambient.HEDDLE_BIN?.trim(), plan = buildPlan({ native });
  if (ambient.UI_TEST_URL) throw new Error('UI_TEST_URL is not accepted: preflight owns its loopback fixture server.');
  if (options.plan) {
    console.log(JSON.stringify({ scope: 'local fixtures only; no live model, cloud auth, deployment or paid CI', checks: plan,
      native: native ? 'requested explicitly by HEDDLE_BIN; offline reviewed fixture installs only' : 'not requested; set HEDDLE_BIN to opt in',
      installs: 'never installs application dependencies or browsers', maximumCheckSeconds: plan.reduce((n, step) => n + step.timeoutMs / 1000, 0) }, null, 2));
    return 0;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22+ is required.');
  if (process.platform === 'win32') throw new Error('Preflight currently requires a POSIX host (Linux or macOS).');
  const output = options.output ? resolve(options.output) : await mkdtemp(join(dirname(ROOT), 'preflight-'));
  await mkdir(output, { recursive: true, mode: 0o700 });
  if ((await readdir(output)).length) throw new Error('Output directory must be new or empty; previous evidence is never overwritten.');
  const runtime = await mkdtemp(join(tmpdir(), 'heddle-preflight-'));
  const replacements = [[runtime, '<runtime>'], [ROOT.replace(/\/$/, ''), '<repo>'], [output, '<evidence>']];
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), scope: 'account-free local checks; fixtures are not live review/model evidence',
    nativeRequested: native, plan, checks: [], sourceChangedDuringRun: false };
  const save = () => writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  try {
    await assertNoRuntimeEnvFiles(ROOT);
    let browserCache;
    if (ambient.HOME) browserCache = process.platform === 'darwin' ? join(ambient.HOME, 'Library', 'Caches', 'ms-playwright') : join(ambient.XDG_CACHE_HOME || join(ambient.HOME, '.cache'), 'ms-playwright');
    const env = safeEnvironment(ambient, runtime, { native, browserCache });
    for (const dir of ['home', 'config', 'cache', 'bin']) await mkdir(join(runtime, dir));
    for (const file of ['npmrc', 'global.npmrc']) await writeFile(join(runtime, file), '');
    const npm = await executable('npm', env.PATH);
    await writeFile(join(runtime, 'bin', 'npm'), npmGuardSource(npm, native), { mode: 0o700 });
    // .mjs is needed because this isolated bin is outside a package type scope.
    await writeFile(join(runtime, 'bin', 'package.json'), '{"type":"module"}\n');
    env.PATH = join(runtime, 'bin') + delimiter + env.PATH;
    env.UI_SCREENSHOT_DIR = join(output, 'screenshots');
    env.LOCAL_FLOW_EVIDENCE = join(output, 'native-storyline.json');
    report.source = await sourceMetadata(ROOT);
    let nativeReady = true;
    if (native) {
      try {
        await access(env.HEDDLE_BIN, constants.X_OK);
        const version = await runProcess(env.HEDDLE_BIN, ['--version'], { env, timeoutMs: 5000 });
        if (version.status !== 'passed' || !/\b0\.30\.0\b/.test(version.output)) throw new Error('HEDDLE_BIN must be a working Heddle 0.30.0 CLI.');
        report.heddle = { version: version.output.trim(), sha256: sha256(await readFile(env.HEDDLE_BIN)), sourcePin: '878fea434d2eed86865c0daf3f3b1ab7da6d2e4f', sourcePinMeaning: 'expected operator-supplied source; version alone does not attest this source revision' };
        for (const command of ['git', 'tar', 'zstd']) await executable(command, env.PATH);
      } catch (error) { nativeReady = false; report.nativePrerequisiteError = sanitizeLog(error.message, replacements); }
    }
    await save();
    for (const step of plan) {
      const start = Date.now();
      let result;
      try {
        const failedDependencies = step.dependsOn.filter(id => report.checks.find(check => check.id === id)?.status !== 'passed');
        if (failedDependencies.length) throw new Error(`Required checks did not pass: ${failedDependencies.join(', ')}`);
        if (step.id === 'native-storyline' && !nativeReady) throw new Error(report.nativePrerequisiteError);
        const cwd = resolve(ROOT, step.cwd);
        for (const file of step.requires) {
          try { await access(join(cwd, file)); } catch { throw new Error(`Missing dependency: ${step.cwd}/${file}. Run the documented explicit setup; nothing was installed.`); }
        }
        const expanded = [];
        for (const arg of step.args) {
          if (arg === '@dev-tests' || arg === '@ui-tests') {
            const directory = arg === '@dev-tests' ? 'dev/test' : 'test';
            const tests = (await readdir(join(cwd, directory))).filter(name => name.endsWith('.test.mjs')).sort();
            if (!tests.length) throw new Error(`No tests found in ${directory}`);
            expanded.push(...tests.map(file => `${directory}/${file}`));
          } else expanded.push(arg === '@browser-output' ? join(output, 'browser-results') : arg);
        }
        console.log(`RUN ${step.id}`);
        result = await runProcess(process.execPath, expanded, { cwd, env, timeoutMs: step.timeoutMs });
      } catch (error) { result = { status: 'blocked', code: null, durationMs: Date.now() - start, output: error.message }; }
      const log = `${step.id}: ${result.status}\n${sanitizeLog(result.output, replacements)}\n`;
      await writeFile(join(output, `${step.id}.log`), log, { mode: 0o600 });
      const { output: ignored, ...summary } = result;
      report.checks.push({ id: step.id, ...summary, log: `${step.id}.log` });
      await save(); console.log(`${result.status.toUpperCase()} ${step.id} (${result.durationMs} ms)`);
    }
    if (!native) report.checks.push({ id: 'native-storyline', status: 'not-requested', reason: 'HEDDLE_BIN was not explicitly set; no native story is claimed.' });
    report.sourceAfter = await sourceMetadata(ROOT);
    report.sourceChangedDuringRun = report.source.sha256 !== report.sourceAfter.sha256;
    report.exitCode = exitCode(report.checks, report.sourceChangedDuringRun);
    report.status = report.exitCode === 0 ? 'passed-selected-local-checks' : 'incomplete-or-failed';
  } catch (error) {
    report.status = 'incomplete-or-failed'; report.exitCode = 1;
    report.setupError = sanitizeLog(error.message, replacements);
  } finally {
    report.finishedAt = new Date().toISOString(); await save();
    await rm(runtime, { recursive: true, force: true });
  }
  console.log(`PREFLIGHT ${report.status}; result: ${join(output, 'result.json')}`);
  return report.exitCode;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`Preflight refused: ${error.message}`); process.exitCode = 2; });
}
