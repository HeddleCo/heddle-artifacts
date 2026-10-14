// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflareConfig, parseCloudflareArgs, upCloudflare, destroyCloudflare } from './up-cloudflare.mjs';

const ACCOUNT = 'a'.repeat(32), QUEUE_ID = 'b'.repeat(32);
const exampleText = await readFile(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');
const example = JSON.parse(exampleText.replace(/^\s*\/\/.*$/gm, ''));

/** A scripted wrangler/docker/npm: answers by argv prefix and records every call. */
function world({ loggedIn = true, accounts = [{ id: ACCOUNT, name: 'Acme' }], docker = true, existing = [], failOn = [], containers = [], loginAfter = 0 } = {}) {
  const calls = [], resources = new Set(existing);
  const run = async (argv, opts = {}) => {
    const line = argv.join(' '); calls.push({ argv, line, opts: { ...opts, env: undefined } });
    for (const f of failOn) if (line.includes(f)) return { code: 1, output: `boom ${f}` };
    if (line.includes('whoami')) return loggedIn ? { code: 0, output: JSON.stringify({ loggedIn: true, accounts }) } : { code: 1, output: 'Not logged in' };
    if (argv[0] === 'docker') return docker ? { code: 0, output: 'ok' } : { code: 1, output: 'Cannot connect to the Docker daemon' };
    if (line.includes('r2 bucket create')) { const n = argv.at(-1); if (resources.has(`r2:${n}`)) return { code: 1, output: 'The bucket you tried to create already exists (10004)' }; resources.add(`r2:${n}`); return { code: 0, output: 'Created' }; }
    if (line.includes('queues create')) { const n = argv.at(-1); if (resources.has(`q:${n}`)) return { code: 1, output: 'Queue already exists (11009)' }; resources.add(`q:${n}`); return { code: 0, output: 'Created' }; }
    if (line.includes('queues info')) return { code: 0, output: `Queue Name: ${argv.at(-1)}\nQueue ID: ${QUEUE_ID}\n` };
    if (line.includes('containers list')) return { code: 0, output: containers.map(c => `│ ${c.id} │ ${c.name} │ ready │ 0 │ x │`).join('\n') };
    if (line.includes(' deploy ')) return { code: 0, output: 'Uploaded\n  https://my-app.acme.workers.dev\nCurrent Version ID: 1' };
    return { code: 0, output: '' };
  };
  return { calls, run, resources };
}
async function setup(opts = {}, args = []) {
  const root = await mkdtemp(join(tmpdir(), 'upcf-')), repo = join(root, 'repo'), state = join(root, 'state');
  await mkdir(repo, { recursive: true });
  const w = world(opts), logs = []; let probes = 0;
  const deps = { run: w.run, log: l => logs.push(String(l)), confirm: async () => opts.confirm ?? true, repo, env: {}, nodeVersion: '22.4.0',
    fetch: async url => { probes++; return { ok: (opts.probeOk ?? true) && probes > (opts.probeFailures ?? 0), status: 200, url: String(url) }; }, sleep: async () => {}, exists: async () => true };
  const options = parseCloudflareArgs(['--name', 'my-app', '--state', state, ...args]);
  return { root, repo, state, w, logs, deps, options, probes: () => probes, done: () => rm(root, { recursive: true, force: true }) };
}

test('arguments: defaults, the options that exist, and refusal of bad names', () => {
  const o = parseCloudflareArgs(['--name', 'my-app']); assert.equal(o.name, 'my-app'); assert.equal(o.yes, false); assert.equal(o.dryRun, false); assert.equal(o.destroy, false);
  assert.equal(parseCloudflareArgs(['--name', 'x', '--yes', '--dry-run', '--domain', 'demo.example.com', '--public-project', 'demo', '--namespace', 'ns-1', '--account', ACCOUNT]).domain, 'demo.example.com');
  for (const bad of ['My App', 'a'.repeat(51), '-x', 'x--y', 'x_y', '']) assert.throws(() => parseCloudflareArgs(['--name', bad]), /name/i, JSON.stringify(bad));
  for (const bad of ['https://demo.example.com', 'demo.example.com/p', 'demo', 'a b.example.com', '.example.com']) assert.throws(() => parseCloudflareArgs(['--name', 'x', '--domain', bad]), /domain/i, bad);
  assert.throws(() => parseCloudflareArgs(['--name', 'x', '--nope']), /Unknown option/);
  assert.throws(() => parseCloudflareArgs([]), /--name/);
});

test('the generated Worker config mirrors wrangler.example.jsonc and substitutes only per-deployment names', () => {
  const c = cloudflareConfig({ name: 'my-app', accountId: ACCOUNT, queueId: QUEUE_ID, namespace: 'my-app' });
  for (const key of ['main', 'compatibility_date', 'compatibility_flags', 'alias', 'durable_objects', 'migrations', 'ai', 'assets']) assert.deepEqual(c[key], example[key], key);
  assert.deepEqual(c.containers.map(x => [x.class_name, x.image, x.image_build_context]), example.containers.map(x => [x.class_name, x.image, x.image_build_context]));
  assert.equal(c.name, 'my-app'); assert.equal(c.account_id, ACCOUNT);
  assert.deepEqual(c.artifacts, [{ binding: 'ARTIFACTS', namespace: 'my-app' }]);
  assert.deepEqual(c.r2_buckets, [{ binding: 'STATE', bucket_name: 'my-app-state' }]);
  assert.deepEqual(c.queues, { producers: [{ binding: 'EVENTS', queue: 'my-app-events' }], consumers: [{ queue: 'my-app-events', max_batch_size: 100, max_batch_timeout: 1, max_retries: 3 }] });
  assert.equal(c.vars.CF_ACCOUNT_ID, ACCOUNT); assert.equal(c.vars.EVENTS_QUEUE_ID, QUEUE_ID); assert.equal(c.vars.ARTIFACTS_NAMESPACE, 'my-app');
});

test('the config never holds a secret, never pins our own account\'s engine image, and makes nothing public unless asked', () => {
  const text = JSON.stringify(cloudflareConfig({ name: 'my-app', accountId: ACCOUNT, queueId: QUEUE_ID, namespace: 'n' }));
  assert.doesNotMatch(text, /OPERATOR_TOKEN|CF_EVENTS_API_TOKEN|secret|Dockerfile\.layer|registry\.cloudflare\.com|163867166be2a9e9a601132b1f3081a4/i);
  assert.equal(cloudflareConfig({ name: 'a', accountId: ACCOUNT, queueId: QUEUE_ID, namespace: 'n' }).vars.DEMO_PROJECT, undefined, 'no public project by default');
  assert.equal(cloudflareConfig({ name: 'a', accountId: ACCOUNT, queueId: QUEUE_ID, namespace: 'n', publicProject: 'demo' }).vars.DEMO_PROJECT, 'demo');
  assert.equal(cloudflareConfig({ name: 'a', accountId: ACCOUNT, queueId: QUEUE_ID, namespace: 'n' }).routes, undefined);
  assert.deepEqual(cloudflareConfig({ name: 'a', accountId: ACCOUNT, queueId: QUEUE_ID, namespace: 'n', domain: 'demo.example.com' }).routes, [{ pattern: 'demo.example.com', custom_domain: true }]);
});

test('each missing prerequisite is named with how to fix it, and nothing is created', async t => {
  for (const [label, opts, pattern] of [['not logged in', { loggedIn: false }, /wrangler login/], ['docker not running', { docker: false }, /Docker/],
    ['several accounts', { accounts: [{ id: ACCOUNT, name: 'A' }, { id: 'c'.repeat(32), name: 'B' }] }, /--account/]]) {
    const s = await setup(opts, ['--yes']); t.after(s.done);
    const result = await upCloudflare(s.options, s.deps);
    assert.equal(result.code, 1, label); assert.match(s.logs.join('\n'), pattern, label);
    assert.deepEqual(s.w.calls.filter(c => /create|deploy|build/.test(c.line)), [], `${label}: nothing mutated`);
  }
});

test('the full run: resources first, then build, then deploy with a secrets file; prints the URL and where the token is', async t => {
  const s = await setup({}, ['--yes']); t.after(s.done);
  const result = await upCloudflare(s.options, s.deps);
  assert.equal(result.code, 0, s.logs.join('\n'));
  const lines = s.w.calls.map(c => c.line), at = re => lines.findIndex(l => re.test(l));
  assert.ok(at(/r2 bucket create my-app-state/) >= 0 && at(/queues create my-app-events/) >= 0);
  assert.ok(at(/queues info my-app-events/) > at(/queues create/), 'queue id read after creation');
  assert.ok(at(/ui/) > at(/queues info/) && at(/ deploy /) > at(/ui/), 'UI built before deploy');
  const deploy = s.w.calls.find(c => / deploy /.test(c.line)).argv;
  assert.ok(deploy.includes('--config') && deploy.includes('--secrets-file'));
  const out = s.logs.join('\n'); assert.match(out, /https:\/\/my-app\.acme\.workers\.dev/); assert.match(out, /operator-token/);
  assert.ok((await readdir(s.repo)).some(f => /^wrangler\.live\..*my-app.*\.json$/.test(f)), 'config written where wrangler.live.* is git-ignored');
});

test('the operator token is created with mode 0600, reused on a second run, and never appears in any command, log or config', async t => {
  const s = await setup({}, ['--yes']); t.after(s.done);
  await upCloudflare(s.options, s.deps);
  const tokenFile = join(s.state, 'my-app', 'operator-token'); const token = (await readFile(tokenFile, 'utf8')).trim();
  assert.match(token, /^[0-9a-f]{64}$/); assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  const everything = JSON.stringify(s.w.calls.map(c => c.argv)) + s.logs.join('\n');
  assert.ok(!everything.includes(token), 'token not in argv or logs');
  for (const f of await readdir(s.repo)) assert.ok(!(await readFile(join(s.repo, f), 'utf8')).includes(token), `token not in ${f}`);
  const second = await setup({ existing: ['r2:my-app-state', 'q:my-app-events'] }, ['--yes']); t.after(second.done);
  await mkdir(join(second.state, 'my-app'), { recursive: true }); await writeFile(join(second.state, 'my-app', 'operator-token'), `${token}\n`, { mode: 0o600 });
  await upCloudflare(second.options, second.deps);
  assert.equal((await readFile(join(second.state, 'my-app', 'operator-token'), 'utf8')).trim(), token, 'an existing token is kept');
});

test('the secrets file is private while it exists and is gone afterwards, even when the deploy fails', async t => {
  for (const failing of [false, true]) {
    const s = await setup(failing ? { failOn: [' deploy '] } : {}, ['--yes']); t.after(s.done);
    let seen;
    const run = s.deps.run; s.deps.run = async (argv, opts) => { if (argv.includes('--secrets-file')) { const f = argv[argv.indexOf('--secrets-file') + 1]; seen = { mode: (await stat(f)).mode & 0o777, body: JSON.parse(await readFile(f, 'utf8')), file: f }; } return run(argv, opts); };
    const result = await upCloudflare(s.options, s.deps);
    assert.equal(result.code, failing ? 1 : 0);
    assert.equal(seen.mode, 0o600); assert.match(seen.body.OPERATOR_TOKEN, /^[0-9a-f]{64}$/);
    await assert.rejects(() => stat(seen.file), /ENOENT/, 'secrets file removed');
  }
});

test('"already exists" on the bucket or queue is fine (re-running is safe); any other failure stops before the deploy', async t => {
  const again = await setup({ existing: ['r2:my-app-state', 'q:my-app-events'] }, ['--yes']); t.after(again.done);
  assert.equal((await upCloudflare(again.options, again.deps)).code, 0);
  for (const failOn of ['r2 bucket create', 'queues create', 'queues info']) {
    const s = await setup({ failOn: [failOn] }, ['--yes']); t.after(s.done);
    assert.equal((await upCloudflare(s.options, s.deps)).code, 1, failOn);
    assert.deepEqual(s.w.calls.filter(c => / deploy /.test(c.line)), [], `${failOn}: no deploy`);
  }
});

test('without --yes the plan is shown and a "no" changes nothing; --dry-run never mutates and never asks', async t => {
  const no = await setup({ confirm: false }); t.after(no.done);
  assert.equal((await upCloudflare(no.options, no.deps)).code, 1);
  assert.match(no.logs.join('\n'), /30 minutes/); assert.match(no.logs.join('\n'), /my-app-state/);
  assert.deepEqual(no.w.calls.filter(c => /create|deploy|ui/.test(c.line)), []);
  const dry = await setup({ confirm: false }, ['--dry-run']); t.after(dry.done);
  assert.equal((await upCloudflare(dry.options, dry.deps)).code, 0);
  assert.deepEqual(dry.w.calls.filter(c => /create|deploy|ui/.test(c.line)), []);
  assert.deepEqual(await readdir(dry.repo), [], 'dry run writes no config');
  assert.match(dry.logs.join('\n'), /Dry run/i);
});

test('success is only reported once the new Worker answers; a Worker that never answers is a failure with its URL', async t => {
  const slow = await setup({ probeFailures: 3 }, ['--yes']); t.after(slow.done);
  assert.equal((await upCloudflare(slow.options, slow.deps)).code, 0); assert.ok(slow.probes() >= 4, 'kept probing');
  const dead = await setup({ probeOk: false }, ['--yes']); t.after(dead.done);
  const result = await upCloudflare(dead.options, dead.deps);
  assert.equal(result.code, 1); assert.match(dead.logs.join('\n'), /did not answer/i); assert.match(dead.logs.join('\n'), /my-app\.acme\.workers\.dev/);
});

test('teardown removes exactly what this command created and nothing else', async t => {
  const s = await setup({ containers: [{ id: 'id-1', name: 'my-app-heddleengine' }, { id: 'id-2', name: 'my-app-candidatetestsandbox' }, { id: 'id-9', name: 'heddle-artifacts-heddleengine' }] }, ['--yes']); t.after(s.done);
  assert.equal((await upCloudflare(s.options, s.deps)).code, 0);
  s.w.calls.length = 0;
  const gone = await destroyCloudflare({ ...s.options, destroy: true, yes: true }, s.deps);
  assert.equal(gone.code, 0, s.logs.join('\n'));
  const lines = s.w.calls.map(c => c.line);
  assert.ok(lines.some(l => /delete my-app\b/.test(l))); assert.ok(lines.some(l => /r2 bucket delete my-app-state/.test(l))); assert.ok(lines.some(l => /queues delete my-app-events/.test(l)));
  assert.ok(lines.some(l => /containers delete id-1/.test(l)) && lines.some(l => /containers delete id-2/.test(l)));
  assert.ok(!lines.some(l => /id-9|heddle-artifacts/.test(l)), 'another deployment\'s container is untouched');
  await assert.rejects(() => stat(join(s.state, 'my-app', 'operator-token')), /ENOENT/);
});

test('teardown refuses a name this command did not create, and asks first without --yes', async t => {
  const stranger = await setup({}, ['--yes']); t.after(stranger.done);
  const refused = await destroyCloudflare({ ...stranger.options, name: 'heddle-artifacts', destroy: true, yes: true }, stranger.deps);
  assert.equal(refused.code, 1); assert.match(stranger.logs.join('\n'), /did not create/i);
  assert.deepEqual(stranger.w.calls.filter(c => /delete/.test(c.line)), []);
  const s = await setup({ confirm: false }, ['--yes']); t.after(s.done);
  await upCloudflare(s.options, s.deps); s.w.calls.length = 0;
  const asked = await destroyCloudflare({ ...s.options, destroy: true, yes: false }, s.deps);
  assert.equal(asked.code, 1); assert.deepEqual(s.w.calls.filter(c => /delete/.test(c.line)), []);
});
