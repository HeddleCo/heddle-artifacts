// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, chmod, symlink, writeFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AUTH_LIMITS, getPrivateOAuthToken, parseOAuthToken, safeOAuthEnv, validateOAuthHome } from '../smoke-auth.mjs';
import { main, smoke, makePlan, validateLivePlan } from '../smoke-artifacts.mjs';
import { safeFailure } from '../smoke-safety.mjs';
const secret = 'SYNTHETIC-OAUTH-ONLY';
async function privateHome(t) {
  const home = await mkdtemp('/tmp/smoke-auth-fixture-'); await mkdir(join(home, 'config'), { mode: 0o700 });
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
function childFixture({ stdout = JSON.stringify({ type: 'oauth', token: secret }), stderr = '', code = 0, hangs = false, throws = false } = {}) {
  let killed = false, calls = 0;
  return { get killed() { return killed; }, get calls() { return calls; }, spawnImpl(bin, args, options) {
    calls++; if (throws) throw new Error('SECRET-SPAWN-ERROR');
    assert.equal(bin, process.execPath); assert.equal(args.length, 4); assert.deepEqual(args.slice(1), ['auth', 'token', '--json']);
    assert(!args.join(' ').includes(secret)); assert(!JSON.stringify(options).includes(secret));
    assert.equal(options.cwd, options.env.HOME); assert.equal(options.env.WRANGLER_WRITE_LOGS, 'false');
    assert.equal(options.env.WRANGLER_SEND_METRICS, 'false'); assert.equal(options.env.XDG_CONFIG_HOME, join(options.env.HOME, 'config'));
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', 1)); };
    if (!hangs) queueMicrotask(() => { child.stdout.write(stdout); child.stderr.write(stderr); child.emit('close', code); });
    return child;
  } };
}
test('OAuth accepts only the exact official oauth token output, with no diagnostic reflection', () => {
  assert.equal(parseOAuthToken(JSON.stringify({ type: 'oauth', token: secret })), secret);
  for (const output of ['', secret, `warning\n${JSON.stringify({ type: 'oauth', token: secret })}`, 'null', '[]',
    JSON.stringify({ type: 'api_token', token: secret }), JSON.stringify({ type: 'api_key', key: secret, email: 'x' }),
    JSON.stringify({ type: 'oauth', token: secret, scopes: [] }), JSON.stringify({ type: 'oauth', token: 'a\nb' }),
    JSON.stringify({ type: 'oauth', token: 'a'.repeat(8193) }), JSON.stringify({ type: 'oauth', token: '' })]) {
    assert.throws(() => parseOAuthToken(output), /^Error: oauth_output_invalid$/);
  }
});
test('OAuth child is allowlisted and omits ambient credentials, proxies, tracing and runtime hooks', () => {
  const environment = safeOAuthEnv('/tmp/synthetic-home');
  assert.deepEqual(Object.keys(environment).sort(), ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'NO_COLOR', 'CLOUDFLARE_AUTH_USE_KEYRING', 'WRANGLER_WRITE_LOGS', 'WRANGLER_SEND_METRICS'].sort());
  assert.equal(environment.CLOUDFLARE_AUTH_USE_KEYRING, 'false');
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'NODE_OPTIONS', 'HTTPS_PROXY', 'WRANGLER_LOG', 'GIT_TRACE']) assert.equal(environment[key], undefined);
});
test('only explicitly selected private /tmp HOME and child XDG directory are accepted, regardless of ambient TMPDIR', async t => {
  const home = await privateHome(t), previous = process.env.TMPDIR;
  process.env.TMPDIR = '/not-the-approved-temp-root';
  try { assert.deepEqual(await validateOAuthHome(home), { home, xdgConfigHome: join(home, 'config') }); }
  finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  for (const wrong of [undefined, '/', '/root', '/tmp', 'relative', `${home}/../${home.split('/').at(-1)}`]) await assert.rejects(validateOAuthHome(wrong));
  await assert.rejects(validateOAuthHome(home, '/tmp'), /private_oauth_home/);
  await chmod(home, 0o755); await assert.rejects(validateOAuthHome(home), /private_directory/); await chmod(home, 0o700);
  const link = join(home, 'link'); await symlink(join(home, 'config'), link); await assert.rejects(validateOAuthHome(home, link), /private_directory/);
});
test('synthetic OAuth subprocess captures token only in memory and suppresses stderr', async t => {
  const home = await privateHome(t), child = childFixture({ stderr: 'SUPPRESSED-SYNTHETIC-DIAGNOSTIC' });
  assert.equal(await getPrivateOAuthToken({ home, spawnImpl: child.spawnImpl }), secret); assert.equal(child.calls, 1);
});
test('OAuth subprocess fails closed on timeout, total-output cap, nonzero status, spawn error and fallback credential type', async t => {
  const home = await privateHome(t);
  for (const [settings, expected] of [[{ hangs: true }, 'oauth_timeout'], [{ stdout: 'x'.repeat(AUTH_LIMITS.maxOutputBytes + 1) }, 'oauth_output_limit'],
    [{ stderr: 'x'.repeat(AUTH_LIMITS.maxOutputBytes + 1) }, 'oauth_output_limit'], [{ code: 1, stderr: secret }, 'oauth_command_failed'],
    [{ throws: true }, 'oauth_spawn_failed'], [{ stdout: JSON.stringify({ type: 'api_token', token: secret }) }, 'oauth_output_invalid']]) {
    const child = childFixture(settings);
    await assert.rejects(getPrivateOAuthToken({ home, spawnImpl: child.spawnImpl, timeoutMs: 15 }), error => error.message === expected && !error.message.includes(secret));
    if (expected === 'oauth_timeout' || expected === 'oauth_output_limit') assert(child.killed);
    assert.equal(safeFailure(new Error(expected)), expected);
  }
});
test('OAuth plan validation never reads ambient token, and local/plan modes never read auth or bridge', async () => {
  const accountId = 'a'.repeat(32), plan = makePlan({ runId: 'auth-plan', accountId, accountName: 'Synthetic', accountPlan: 'Workers Paid', namespace: 'heddle-demo', jurisdiction: 'unrestricted' });
  const environment = { CF_ACCOUNT_ID: accountId, get CLOUDFLARE_API_TOKEN() { throw new Error('ambient token was read'); } };
  assert.equal(validateLivePlan(plan, plan.runId, environment, Date.now(), { authMode: 'wrangler-oauth' }), plan);
  const forbidden = () => { throw new Error('must not be called'); }, none = new Proxy({}, { get: forbidden });
  assert.equal(await main(['--plan'], { env: none, fetchImpl: forbidden, oauthTokenProvider: forbidden, bridgeFactory: forbidden, log: () => {} }), 0);
  assert.equal(await main(['--plan', '--oauth-home', '/tmp/no-read'], { env: none, oauthTokenProvider: forbidden, bridgeFactory: forbidden, log: () => {} }), 2);
  assert.equal(await main(['--fake', '--bridge-dir', '/tmp/no-read'], { env: none, oauthTokenProvider: forbidden, bridgeFactory: forbidden, log: () => {} }), 2);
  assert.equal(await smoke({ local: true, env: none, fetchImpl: forbidden, oauthTokenProvider: forbidden, bridgeFactory: forbidden, log: () => {} }), 0);
  assert.equal(await smoke({ plan, runId: plan.runId, ledgerDir: '/never-created', authMode: 'wrangler-oauth', env: environment, oauthTokenProvider: forbidden, log: () => {} }), 2);
});

test('nested Wrangler auth stores cannot escape via symlinks, hardlinks, shared modes or special paths', async t => {
  const home = await privateHome(t), outside = await privateHome(t), target = join(outside, 'synthetic.toml');
  await writeFile(target, 'SYNTHETIC-NOT-CREDENTIALS', { mode: 0o600 });
  const legacy = join(home, '.wrangler'); await symlink(outside, legacy);
  await assert.rejects(validateOAuthHome(home), /private_oauth_home_required/); await rm(legacy);
  const nested = join(home, 'config', '.wrangler'); await mkdir(nested, { mode: 0o700 });
  const config = join(nested, 'config'); await mkdir(config, { mode: 0o700 });
  const file = join(config, 'default.toml'); await symlink(target, file);
  await assert.rejects(validateOAuthHome(home), /private_oauth_home_required/); await rm(file);
  await link(target, file); await assert.rejects(validateOAuthHome(home), /private_oauth_home_required/); await rm(file);
  await writeFile(file, 'SYNTHETIC-NOT-CREDENTIALS', { mode: 0o644 });
  await assert.rejects(validateOAuthHome(home), /private_oauth_home_required/); await chmod(file, 0o600);
  assert.equal((await validateOAuthHome(home)).home, home);
});
