// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PLATFORM_CA, validatePlatformProxy, validateGitTransportConfig, loadGitTransportConfig, scopedGitTransport, categorizeGitFailure, safeGitPhase } from '../smoke-transport.mjs';
import { safeGitEnv, boundedGit, safeFailure, makePlan } from '../smoke-safety.mjs';
import { main, smoke } from '../smoke-artifacts.mjs';
const PLATFORM_GIT_PROXY = 'http://127.0.0.1:12345/'; // Synthetic per-launch endpoint; never contacted.
const remote = `https://${'a'.repeat(32)}.artifacts.cloudflare.net/git/heddle-demo/as1-transport.git`;
const config = () => ({ version: 1, proxy: PLATFORM_GIT_PROXY, caFile: PLATFORM_CA.path, caSha256: PLATFORM_CA.sha256 });
async function fixture(t) {
  const root = await mkdtemp('/tmp/smoke-transport-fixture-'), home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const path = join(root, 'transport.json'); await writeFile(path, JSON.stringify(config()), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true })); return { root, home, path };
}
async function prepared(t) {
  const f = await fixture(t);
  try { return { ...f, transport: await loadGitTransportConfig(f.path, { home: f.home, platformProxy: PLATFORM_GIT_PROXY, remote }) }; }
  catch (error) { if (error.code === 'ENOENT' && error.path === PLATFORM_CA.path) { t.skip('Optional pinned platform public CA is not installed in this environment'); return null; } throw error; }
}
const configMap = env => Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
function mockGit({ stderr = '', stdout = '', code = 1, inspect = () => {} } = {}) {
  return (_bin, args, options) => {
    inspect(args, options);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => queueMicrotask(() => child.emit('close', 1));
    queueMicrotask(() => { child.stdout.write(stdout); for (const part of Array.isArray(stderr) ? stderr : [stderr]) child.stderr.write(part); child.emit('close', code); });
    return child;
  };
}
test('transport config pins only the approved credential-free loopback proxy and exact CA identity', () => {
  assert.deepEqual(validateGitTransportConfig(config()), config());
  assert.equal(validateGitTransportConfig({ ...config(), proxy: 'http://127.0.0.1:54321/' }).proxy, 'http://127.0.0.1:54321/');
  for (const changes of [{ proxy: 'http://localhost:46783/' }, { proxy: 'http://2130706433:46783/' },
    { proxy: 'https://127.0.0.1:46783/' }, { proxy: 'http://user:secret@127.0.0.1:46783/' }, { proxy: 'http://127.0.0.1:46783/path' },
    { proxy: 'http://127.0.0.1:46783/?secret=x' }, { proxy: 'http://127.0.0.1:46783/#fragment' }, { proxy: 'http://192.0.2.1:46783/' }, { proxy: 'http://127.0.0.1:0/' }, { proxy: 'http://127.0.0.1:65536/' },
    { caFile: '/tmp/foreign-ca.pem' }, { caSha256: '0'.repeat(64) }, { version: 2 }, { sslVerify: false }, { authorization: 'SECRET' }]) {
    assert.throws(() => validateGitTransportConfig({ ...config(), ...changes }), /git_transport_config_invalid/);
  }
});
test('explicit config requires private owned regular files and directories, rejecting links and oversized JSON', async t => {
  const f = await fixture(t), load = path => loadGitTransportConfig(path, { home: f.home, platformProxy: PLATFORM_GIT_PROXY, remote });
  await chmod(f.path, 0o644); await assert.rejects(load(f.path), /git_transport_config_invalid/); await chmod(f.path, 0o600);
  const alias = join(f.root, 'alias.json'); await symlink(f.path, alias); await assert.rejects(load(alias), /git_transport_config_invalid/);
  const hard = join(f.root, 'hard.json'); await link(f.path, hard); await assert.rejects(load(f.path), /git_transport_config_invalid/); await rm(hard);
  await chmod(f.root, 0o755); await assert.rejects(load(f.path), /private_directory_required/); await chmod(f.root, 0o700);
  await writeFile(f.path, 'x'.repeat(4097)); await assert.rejects(load(f.path), /git_transport_config_invalid/);
  await writeFile(f.path, 'invalid json'); await assert.rejects(load(f.path), /git_transport_config_invalid/);
  await assert.rejects(load('relative.json'), /git_transport_config_invalid/);
  await assert.rejects(loadGitTransportConfig(f.path, { home: f.home, remote: remote + '\n', platformProxy: PLATFORM_GIT_PROXY }), /git_transport_config_invalid/);
});
test('CA metadata and SHA256 are checked before any transport is accepted', async t => {
  const f = await fixture(t); let caChecked = false;
  await assert.rejects(loadGitTransportConfig(f.path, { home: f.home, platformProxy: PLATFORM_GIT_PROXY, remote, readFileImpl: async (path, maxBytes, checkMetadata) => {
    if (path === f.path) { assert.equal(maxBytes, 4096); assert(checkMetadata({ uid: process.getuid(), mode: 0o600 })); assert(!checkMetadata({ uid: process.getuid() + 1, mode: 0o600 })); return Buffer.from(JSON.stringify(config())); }
    assert.equal(path, PLATFORM_CA.path); assert.equal(maxBytes, 131072); caChecked = true;
    assert(checkMetadata({ uid: PLATFORM_CA.uid, mode: 0o644 })); assert(checkMetadata({ uid: PLATFORM_CA.uid, mode: 0o444 }));
    for (const metadata of [{ uid: PLATFORM_CA.uid + 1, mode: 0o644 }, { uid: PLATFORM_CA.uid, mode: 0o666 }, { uid: PLATFORM_CA.uid, mode: 0o640 }]) assert(!checkMetadata(metadata));
    return Buffer.from('SYNTHETIC-WRONG-CA');
  } }), /git_transport_ca_mismatch/);
  assert(caChecked);
});
test('pinned public CA is snapshotted privately and transport options apply only to the exact validated remote', async t => {
  const f = await prepared(t); if (!f) return;
  assert(Object.isFrozen(f.transport)); assert.notEqual(f.transport.caFile, PLATFORM_CA.path);
  assert.equal(f.transport.sourceCaFile, PLATFORM_CA.path); assert.equal((await stat(f.transport.caFile)).mode & 0o777, 0o600);
  assert.equal(createHash('sha256').update(await readFile(f.transport.caFile)).digest('hex'), PLATFORM_CA.sha256);
  assert.equal(f.transport.caFile.startsWith(f.home + '/'), true);
  const env = safeGitEnv(f.home, 'SYNTHETIC-REPO-TOKEN', remote, f.transport), settings = configMap(env);
  assert.equal(settings[`http.${remote}.proxy`], PLATFORM_GIT_PROXY); assert.equal(settings[`http.${remote}.sslCAInfo`], f.transport.caFile);
  assert.equal(settings[`http.${remote}.sslVerify`], 'true'); assert.equal(settings[`http.${remote}.extraheader`], 'Authorization: Bearer SYNTHETIC-REPO-TOKEN');
  assert.equal(settings['http.followRedirects'], 'false'); assert.equal(settings['credential.helper'], ''); assert.equal(settings['core.hooksPath'], '/dev/null');
  for (const key of ['http.proxy', 'http.sslCAInfo', 'http.sslVerify']) assert.equal(settings[key], undefined);
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_NO_VERIFY', 'NODE_OPTIONS', 'CLOUDFLARE_API_TOKEN']) assert.equal(env[key], undefined);
  for (const wrong of [remote + '?token=SECRET', remote.replace('https://', 'http://'), remote.replace('/as1-transport.git', '/foreign.git'), remote.replace('a'.repeat(32), 'b'.repeat(32))]) {
    assert.throws(() => scopedGitTransport(f.transport, wrong, f.home), /git_transport_config_invalid/);
  }
  assert.throws(() => scopedGitTransport({ ...f.transport }, remote, f.home), /git_transport_config_invalid/);
  assert.throws(() => scopedGitTransport(f.transport, remote, f.root), /git_transport_config_invalid/);
  assert.equal(Object.keys(configMap(safeGitEnv(f.home))).some(key => /proxy|sslCAInfo|sslVerify/.test(key)), false);
});
test('mock Git receives explicit URL-scoped transport but no token or transport secrets in argv', async t => {
  const f = await prepared(t); if (!f) return;
  const output = await boundedGit(['ls-remote', remote], f.home, { home: f.home, platformProxy: PLATFORM_GIT_PROXY, remote, transport: f.transport, token: 'SYNTHETIC-REPO-TOKEN', phase: 'final_refs',
    spawnImpl: mockGit({ code: 0, stdout: 'synthetic refs', inspect: (args, opts) => {
      assert(!args.join(' ').includes('SYNTHETIC-REPO-TOKEN')); assert(!args.join(' ').includes(PLATFORM_GIT_PROXY));
      assert.equal(configMap(opts.env)[`http.${remote}.sslVerify`], 'true'); assert.equal(opts.env.GIT_TRACE, undefined);
    } }) });
  assert.equal(output, 'synthetic refs');
});
test('Git errors expose only fixed categories and allowlisted phases, including split stderr chunks', async () => {
  const cases = [['Could not resolve host: SECRET.invalid', 'git_dns'], ['Could not resolve proxy: SECRET', 'git_proxy_dns'],
    ['CONNECT tunnel failed, response 407 SECRET', 'git_proxy_auth'], ['server certificate verification failed SECRET', 'git_tls'],
    ['Authentication failed SECRET', 'git_auth'], ['requested URL returned error: 403 SECRET', 'git_auth'], ['repository SECRET not found', 'git_remote_missing'],
    ['the receiving end does not support --atomic push SECRET', 'git_atomic_unsupported'], ['rejected (non-fast-forward) SECRET', 'git_non_fast_forward'],
    ['rejected (fetch first) SECRET', 'git_non_fast_forward'], ['rejected (stale info) SECRET', 'git_stale_info'], ['Failed to connect to SECRET', 'git_connect'], ['Operation timed out SECRET', 'git_timeout'], ['private details SECRET', 'git_failed']];
  for (const [stderr, expected] of cases) {
    assert.equal(categorizeGitFailure(stderr), expected); assert.equal(safeFailure(new Error(expected)), expected);
    await assert.rejects(boundedGit(['push', remote, 'HEAD:main'], '/tmp', { home: '/tmp', remote, token: 'SYNTHETIC-REPO-TOKEN', phase: 'main_push',
      spawnImpl: mockGit({ stderr: [stderr.slice(0, 9), stderr.slice(9)] }) }), error => error.message === expected && error.gitPhase === 'main_push' && !JSON.stringify(error).includes('SECRET'));
  }
  assert.equal(safeGitPhase('SECRET'), 'unknown');
  await assert.rejects(boundedGit(['status'], '/tmp', { home: '/tmp', phase: 'SECRET', spawnImpl: mockGit({ stderr: 'SECRET' }) }), error => error.gitPhase === 'unknown' && error.message === 'git_failed');
});
test('Git output cap remains fail-closed and does not turn a capped diagnostic into a service verdict', async () => {
  await assert.rejects(boundedGit(['status'], '/tmp', { home: '/tmp', phase: 'notes_push', spawnImpl: mockGit({ stderr: '😀'.repeat(5000) + 'Could not resolve host: SECRET' }) }), error => error.message === 'git_failed');
  await assert.rejects(boundedGit(['status'], '/tmp', { home: '/tmp', phase: 'notes_push', spawnImpl: mockGit({ stderr: 'non-fast-forward ' + 'SECRET'.repeat(200000) }) }), error => error.message === 'git_output_limit' && error.gitPhase === 'notes_push');
});
test('plan/fake modes never load transport configuration or inherit ambient proxy/CA', async () => {
  const forbidden = () => { throw new Error('unexpected transport/auth/network read'); }, environment = new Proxy({}, { get: forbidden });
  assert.equal(await main(['--plan'], { env: environment, gitTransportLoader: forbidden, log: () => {} }), 0);
  for (const mode of ['--plan', '--fake']) assert.equal(await main([mode, '--git-transport-config', '/never-read'], { env: environment, gitTransportLoader: forbidden, log: () => {} }), 2);
  const out = [];
  assert.equal(await smoke({ local: true, gitTransportConfig: '/never-read', gitTransportLoader: forbidden, env: environment, fetchImpl: forbidden, log: message => out.push(message) }), 0);
  assert(out.includes('GIT FAIL stale_main_cas: git_stale_info (diagnostics suppressed)'));
  assert(out.includes('GIT NETWORK COMMANDS 7/7'));
});
test('invalid explicit transport blocks a live-mode fixture before OAuth, bridge or network setup', async t => {
  const f = await fixture(t), accountId = 'a'.repeat(32), plan = makePlan({ runId: 'transport-blocked', accountId, accountName: 'Synthetic', accountPlan: 'Workers Paid', namespace: 'heddle-demo', jurisdiction: 'unrestricted' });
  await writeFile(f.path, JSON.stringify({ ...config(), proxy: 'http://foreign.invalid/' }));
  const forbidden = () => { throw new Error('must not be reached'); }, logs = [];
  assert.equal(await smoke({ plan, runId: plan.runId, ledgerDir: join(f.root, 'ledger'), authMode: 'wrangler-oauth', oauthHome: '/tmp/synthetic-only', bridgeDir: '/tmp/synthetic-only',
    gitTransportConfig: f.path, env: { CF_ACCOUNT_ID: accountId }, oauthTokenProvider: forbidden, bridgeFactory: forbidden, fetchImpl: forbidden, log: s => logs.push(s) }), 1);
  assert(logs.includes('SMOKE FAIL: git_transport_config_invalid (credentials suppressed)')); assert(!logs.some(line => line.startsWith('A-S1 PASS')));
});

test('stale, mismatched, absent or malformed per-launch proxy fails before CA reads', async t => {
  const f = await fixture(t);
  for (const platformProxy of [undefined, '', 'http://127.0.0.1:54321/', 'http://user:secret@127.0.0.1:12345/', 'http://foreign.invalid/']) {
    let reads = 0;
    await assert.rejects(loadGitTransportConfig(f.path, { home: f.home, remote, platformProxy, readFileImpl: async path => {
      reads++; assert.equal(path, f.path); return Buffer.from(JSON.stringify(config()));
    } }), /git_transport_config_invalid/);
    assert.equal(reads, 1);
  }
});
test('default live-mode fixture never reads runtime HTTPS_PROXY when transport is absent', async t => {
  const f = await fixture(t), accountId = 'a'.repeat(32), plan = makePlan({ runId: 'default-no-proxy', accountId, accountName: 'Synthetic', accountPlan: 'Workers Paid', namespace: 'heddle-demo', jurisdiction: 'unrestricted' });
  const env = { CF_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'SYNTHETIC-ONLY', get HTTPS_PROXY() { throw new Error('must not read proxy'); } };
  assert.equal(await smoke({ plan, runId: plan.runId, ledgerDir: join(f.root, 'ledger'), env,
    gitTransportLoader: () => { throw new Error('must not load transport'); },
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ success: false }) }), log: () => {} }), 1);
});

test('same-launch endpoint comparison accepts absent trailing slash without accepting URL aliases', async t => {
  assert.equal(validatePlatformProxy('http://127.0.0.1:12345'), 'http://127.0.0.1:12345/');
  for (const proxy of ['http://127.0.0.1:12345/\n', 'http://127.0.0.1:12345/\r', 'http://127.0.0.1:012345/', 'http://127.0.0.1:12345//', 'http://127.0.0.1:12345/./',
    'http://127.0.0.1:12345/%2f', 'http://127.0.0.1:12345/?', 'http://127.0.0.1:12345/#', 'http://127%2e0.0.1:12345/', 'http://127.1:12345/']) {
    assert.throws(() => validatePlatformProxy(proxy), /git_transport_config_invalid/);
  }
  const f = await prepared(t); if (!f) return;
  const transport = await loadGitTransportConfig(f.path, { home: f.home, remote, platformProxy: PLATFORM_GIT_PROXY.slice(0, -1) });
  assert.equal(transport.proxy, PLATFORM_GIT_PROXY);
  await writeFile(f.path, JSON.stringify({ ...config(), proxy: PLATFORM_GIT_PROXY.slice(0, -1) }));
  assert.equal((await loadGitTransportConfig(f.path, { home: f.home, remote, platformProxy: PLATFORM_GIT_PROXY })).proxy, PLATFORM_GIT_PROXY);
});
