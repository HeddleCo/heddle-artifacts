// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertNoRuntimeEnvFiles, buildPlan, exitCode, npmGuardSource, parseArgs, runProcess, safeEnvironment, sanitizeLog, sourceMetadata } from '../preflight.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('fixed preflight covers all actual local suites and never opts into native or live work implicitly', () => {
  const plan = buildPlan();
  assert.deepEqual(plan.map(x => x.id), ['root-typecheck', 'ui-typecheck', 'ui-build', 'worker-tests', 'dev-tests', 'reviewer-typecheck', 'reviewer-tests', 'ui-unit', 'ui-decision-negative', 'ui-verification-negative', 'trusted-fixture-manifest', 'ui-browser']);
  assert.equal(new Set(plan.map(x => x.id)).size, plan.length);
  assert.ok(plan.every(x => x.timeoutMs > 0 && x.timeoutMs <= 180000));
  assert.ok(!JSON.stringify(plan).match(/\b(?:deploy|login|install|npx|live|genuine-rehearsal)\b/));
  assert.deepEqual(plan.find(x => x.id === 'ui-browser').dependsOn, ['ui-build']);
  const native = buildPlan({ native: true });
  assert.deepEqual(native.at(-1).args, ['dev/local-flow.mjs', '--storyline']);
  assert.equal(native.at(-1).timeoutMs, 300000);
  assert.ok(native.at(-1).dependsOn.includes('trusted-fixture-manifest'));
});

test('CLI refuses alternate commands, remote modes and ignored options', () => {
  assert.deepEqual(parseArgs(['--plan', '--output', '/tmp/example']), { plan: true, output: '/tmp/example' });
  for (const args of [['--deploy'], ['--without-browser'], ['--live'], ['--output'], ['--output', '--plan'], ['--output', 'a', '--output', 'b']]) assert.throws(() => parseArgs(args), /Usage:/);
});

test('environment excludes credentials, process injection, auth homes and alternate runtime endpoints', () => {
  const ambient = { PATH: '/usr/bin:/bin', HOME: '/private/user', TMPDIR: '/tmp',
    OPERATOR_TOKEN: 'secret1', CLOUDFLARE_API_TOKEN: 'secret2', OPENAI_API_KEY: 'secret3',
    GITHUB_TOKEN: 'secret4', HTTP_PROXY: 'secret5', NODE_OPTIONS: '--import /private/injection',
    ENGINE_SCRIPT: '/private/engine', HEDDLE_TRUSTED_TEST_MANIFEST: '/private/manifest',
    HEDDLE_BIN: '/private/heddle', GIT_CONFIG_COUNT: '1', NPM_CONFIG_REGISTRY: 'https://remote.invalid',
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/opt/chromium' };
  const env = safeEnvironment(ambient, '/tmp/runtime');
  for (const key of ['OPERATOR_TOKEN', 'CLOUDFLARE_API_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'HTTP_PROXY', 'NODE_OPTIONS', 'ENGINE_SCRIPT', 'HEDDLE_TRUSTED_TEST_MANIFEST', 'HEDDLE_BIN', 'GIT_CONFIG_COUNT', 'NPM_CONFIG_REGISTRY']) assert.equal(env[key], undefined, key);
  assert.equal(env.HOME, '/tmp/runtime/home');
  assert.equal(env.CI, '1'); assert.equal(env.WRANGLER_SEND_METRICS, 'false');
  assert.equal(env.NPM_CONFIG_OFFLINE, 'true'); assert.equal(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
  assert.equal(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, '/opt/chromium');
  assert.equal(safeEnvironment(ambient, '/tmp/runtime', { native: true }).HEDDLE_BIN, '/private/heddle');
  assert.throws(() => safeEnvironment({}, '/tmp/runtime', { native: true }), /explicit HEDDLE_BIN/);
  for (const url of ['https://production.invalid', 'http://127.0.0.1:9999']) assert.throws(() => safeEnvironment({ UI_TEST_URL: url }, '/tmp/runtime'), /loopback/);
  assert.ok(!JSON.stringify(env).includes('secret'));
});

test('passed, failed, spawn, missing-module, signal, timeout, and output-limit checks remain distinct', async () => {
  const run = (args, options = {}) => runProcess(process.execPath, args, { env: { PATH: process.env.PATH }, timeoutMs: 2000, ...options });
  assert.equal((await run(['-e', 'console.log("fixture pass")'])).status, 'passed');
  const failed = await run(['-e', 'process.exit(7)']); assert.equal(failed.status, 'failed'); assert.equal(failed.code, 7);
  assert.equal((await run(['/definitely/missing/dependency.mjs'])).status, 'failed');
  const absent = await runProcess('/definitely/missing/executable', [], { timeoutMs: 1000 });
  assert.equal(absent.status, 'failed'); assert.equal(absent.error, 'ENOENT');
  const signalled = await run(['-e', 'process.kill(process.pid,"SIGTERM")']);
  assert.equal(signalled.status, 'failed'); assert.equal(signalled.signal, 'SIGTERM');
  const hung = await run(['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(hung.status, 'failed'); assert.equal(hung.timedOut, true);
  const loud = await run(['-e', 'process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000)'], { maxBytes: 128 });
  assert.equal(loud.status, 'failed'); assert.equal(loud.overflow, true); assert.ok(loud.output.length <= 128);
});

test('browser blockers, missing dependencies, and changing source cannot yield a green exit', () => {
  assert.equal(exitCode([{ status: 'passed' }, { status: 'not-requested' }]), 0);
  for (const status of ['failed', 'blocked', 'skipped', 'unrun']) assert.equal(exitCode([{ status: 'passed' }, { id: 'ui-browser', status }]), 1);
  assert.equal(exitCode([{ status: 'passed' }], true), 1);
});

test('npm wrapper refuses installs by default and forces opted-in fixture reconstruction offline', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'preflight-npm-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const fixture = join(temp, 'fake-npm.mjs'), guard = join(temp, 'guard.mjs');
  await writeFile(fixture, 'console.log(JSON.stringify({args:process.argv.slice(2),offline:process.env.NPM_CONFIG_OFFLINE}));\n');
  const invoke = async (args, native = false) => {
    await writeFile(guard, npmGuardSource(fixture, native));
    return runProcess(process.execPath, [guard, ...args], { timeoutMs: 2000 });
  };
  for (const args of [['ci', '--ignore-scripts'], ['install'], ['exec', 'wrangler', 'deploy'], ['publish'], ['run', 'deploy']]) {
    const result = await invoke(args); assert.equal(result.status, 'failed'); assert.equal(result.code, 2);
  }
  for (const args of [['test', '--silent'], ['run', 'dev:worker']]) assert.equal((await invoke(args)).status, 'passed');
  assert.equal((await invoke(['ci'], true)).status, 'failed');
  const installed = await invoke(['ci', '--ignore-scripts', '--silent'], true);
  assert.equal(installed.status, 'passed');
  const actual = JSON.parse(installed.output);
  assert.ok(actual.args.includes('--offline')); assert.ok(actual.args.includes('--ignore-scripts'));
  assert.equal(actual.offline, 'true');
  const broken = join(temp, 'broken.mjs'); await writeFile(broken, 'process.exit(73);\n');
  await writeFile(guard, npmGuardSource(broken, true));
  assert.equal((await runProcess(process.execPath, [guard, 'ci', '--ignore-scripts'], { timeoutMs: 2000 })).code, 73);
});

test('portable report metadata hashes current files and all four lockfiles without runtime secrets', async () => {
  const source = await sourceMetadata(root);
  assert.equal(source.locks.length, 4);
  assert.ok(source.files.some(x => x.path === 'dev/preflight.mjs'));
  assert.ok(source.files.some(x => x.path === 'demo/evidence/genuine-native-v1/candidates/native-parity/src/table.ts'));
  assert.ok(source.files.every(x => /^[a-f0-9]{64}$/.test(x.sha256) && !x.path.startsWith('/')));
  assert.ok(source.files.every(x => !/(?:node_modules|\.env|\.dev.vars|test-results)/.test(x.path)));
  assert.match(source.sha256, /^[a-f0-9]{64}$/);
});

test('logs redact ordinary bearer/secret shapes and local root paths', () => {
  const output = sanitizeLog('Authorization: Bearer fake-secret\nCLOUDFLARE_API_TOKEN=other-secret\nhttps://user:password@example.invalid/x\n/private/repo/file.ts', [['/private/repo', '<repo>']]);
  for (const value of ['fake-secret', 'other-secret', 'user:password', '/private/repo']) assert.ok(!output.includes(value));
  assert.ok(output.includes('<repo>/file.ts'));
});

test('--plan is read-only and does not claim test execution', async () => {
  const result = await runProcess(process.execPath, ['dev/preflight.mjs', '--plan'], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 5000 });
  assert.equal(result.status, 'passed');
  const plan = JSON.parse(result.output); assert.equal(plan.checks.length, 12); assert.match(plan.native, /not requested/);
  const code = await readFile(new URL('../preflight.mjs', import.meta.url), 'utf8');
  assert.ok(code.indexOf('if (options.plan)') < code.indexOf('await mkdir(output'));
});


test('Wrangler auto-loaded files and project npm configuration fail closed without reading them', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'preflight-envfiles-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(join(temp, 'ui')); await mkdir(join(temp, 'reviewer'));
  await assertNoRuntimeEnvFiles(temp);
  for (const scope of ['.', 'ui', 'reviewer']) {
    for (const name of ['.env', '.env.local', '.env.production', '.dev.vars', '.dev.vars.local', '.npmrc']) {
      const file = join(temp, scope, name);
      await writeFile(file, 'PRIVATE-FIXTURE-VALUE');
      await assert.rejects(assertNoRuntimeEnvFiles(temp), error => {
        assert.match(error.message, /Runtime configuration file is not allowed/);
        assert.ok(!error.message.includes('PRIVATE-FIXTURE-VALUE')); return true;
      });
      assert.equal(await readFile(file, 'utf8'), 'PRIVATE-FIXTURE-VALUE');
      await rm(file);
    }
  }
});

test('timeout force-cleans a detached grandchild even when its parent closes first', { skip: process.platform === 'win32' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'preflight-descendant-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const pidFile = join(temp, 'pid');
  const grandchild = `process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  const parent = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000);`;
  const result = await runProcess(process.execPath, ['-e', parent], { timeoutMs: 350 });
  assert.equal(result.status, 'failed'); assert.equal(result.timedOut, true);
  const pid = Number(await readFile(pidFile, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  // A reparented killed process can be a zombie until its host reaps it.
  const { spawnSync } = await import('node:child_process');
  const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  assert.ok(!state.stdout.trim() || state.stdout.trim().startsWith('Z'), `grandchild still alive: ${state.stdout}`);
});


test('browser web server preserves the caller isolated Wrangler auth directory', async () => {
  const text = await readFile(new URL('../../ui/playwright.config.ts', import.meta.url), 'utf8');
  assert.match(text, /XDG_CONFIG_HOME:\s*process\.env\.XDG_CONFIG_HOME\s*\|\|\s*['"]\/tmp\/heddle-c-config['"]/);
  assert.equal(safeEnvironment({}, '/private/preflight').XDG_CONFIG_HOME, '/private/preflight/config');
});
